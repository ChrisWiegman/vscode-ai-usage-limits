# AI Limits

A VS Code extension that shows your **Claude** and **Codex (ChatGPT)** usage budgets directly in the status bar — no separate configuration required.

## Features

- **Claude budget** – powered by the [Claude Code](https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code) extension login
- **Codex budget** – powered by the [ChatGPT](https://marketplace.visualstudio.com/items?itemName=openai.chatgpt) extension login
- Displays **last 5 hours** and **last 7 days** cost in the status bar
- Tooltip shows detailed breakdown including limit (if one is configured)
- Auto-refreshes every 5 minutes and whenever authentication sessions change

## Requirements

Install at least one of the companion extensions and sign in:

| Extension | Marketplace ID | Purpose |
|-----------|---------------|---------|
| Claude Code | `anthropic.claude-code` | Provides Anthropic authentication |
| ChatGPT | `openai.chatgpt` | Provides OpenAI authentication |

**AI Limits** will only show a status bar item for extensions that are both installed *and* authenticated. If neither is present, the extension activates silently with no UI impact.

## Status Bar Format

```
$(pulse) Claude 5h:$0.12 7d:$1.45   $(pulse) Codex 5h:$0.05 7d:$3.20
```

Hover over an item for a detailed tooltip with exact figures and any configured spending limits.

| Icon | Meaning |
|------|---------|
| `$(pulse)` | Live usage data |
| `$(lock)` | Extension installed but not signed in |
| `$(warning)` | Error fetching data |
| `$(sync~spin)` | Fetching data |

## How It Works

1. On startup the extension checks whether `anthropic.claude-code` and/or `openai.chatgpt` are installed.
2. For each installed extension it reads credentials from the same on-disk / keychain location that extension uses (no separate login is ever required):
   - **Claude Code**: reads the macOS Keychain entry for service `"Claude Code-credentials"` (account = `$USER`). Falls back to `~/.claude/.credentials.json` on non-macOS systems or if the keychain is unavailable.
   - **OpenAI / Codex**: reads `~/.codex/auth.json` (or `$CODEX_HOME/auth.json`), which the local Codex agent daemon maintains.
3. The extension resolves usage data from the most reliable source available:
   - **Anthropic**: `GET https://api.anthropic.com/v1/usage` with `start_time` / `end_time` query parameters
   - **OpenAI API key auth**: `GET https://api.openai.com/v1/usage?date=YYYY-MM-DD` plus `GET /v1/dashboard/billing/subscription`
   - **Codex ChatGPT OAuth auth**: reads the latest local Codex session rollout (`~/.codex/sessions/**/rollout-*.jsonl`) and uses the embedded `rate_limits` snapshot (`300` min and `10080` min windows)
4. Costs are displayed in USD.  Where the API does not return cost directly, costs are estimated from token counts using current list pricing.

## Known Limitations

### Anthropic Usage API Scope

The OAuth token stored by Claude Code has the `user:inference` scope (for making model calls). Anthropic's usage/billing API may require a different scope or an admin API key. If the status bar shows `$(warning) Claude: error` and the tooltip says HTTP 403, the token does not have access to the usage endpoint. There is currently no workaround for consumer `claude.ai` accounts; the error state is shown rather than hiding the item entirely.

### 5-hour window (OpenAI API key mode)

OpenAI's usage endpoint returns data aggregated by UTC calendar day.  The 5-hour figure is pro-rated from today's usage based on the elapsed fraction of the day, so it is an approximation.

### Codex ChatGPT OAuth mode

When authenticated via ChatGPT OAuth (no `OPENAI_API_KEY`), the extension shows **rate-limit utilization percentages** for the 5-hour and 7-day windows from Codex's local session snapshot, instead of USD spend.

### Cost estimation

When the API response does not include a pre-computed cost field, costs are estimated using hardcoded list pricing:

| Service | Model assumed | Input | Output |
|---------|--------------|-------|--------|
| Anthropic | Claude 3.5 Sonnet | $3 / 1M tokens | $15 / 1M tokens |
| OpenAI | GPT-4o | $5 / 1M tokens | $15 / 1M tokens |

Actual costs may differ if you use other models or have negotiated pricing.

## Development

```bash
# Install dependencies
npm install

# Compile TypeScript
npm run compile

# Run tests (requires VS Code to be installed)
npm test

# Watch mode
npm run watch
```

### Project Structure

```
src/
  extension.ts          Entry point; wires providers, status bar, and refresh timer
  types.ts              Shared TypeScript interfaces
  statusBarManager.ts   Creates and updates the two status bar items
  providers/
    claudeProvider.ts   Fetches usage from the Anthropic API
    openaiProvider.ts   Fetches usage from the OpenAI API
test/
  runTests.ts           Launches the VS Code Extension Development Host test runner
  suite/
    index.ts            Mocha suite loader
    claudeProvider.test.ts
    openaiProvider.test.ts
    statusBarManager.test.ts
```

## License

MIT
