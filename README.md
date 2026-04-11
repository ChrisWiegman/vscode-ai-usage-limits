# AI Limits

A VS Code extension that shows your **Claude** and **Codex** usage in the status bar using the credentials already managed by their companion tools.

## Features

- **Claude budget** – powered by the [Claude Code](https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code) extension login
- **Codex budget** – powered by the [ChatGPT](https://marketplace.visualstudio.com/items?itemName=openai.chatgpt) extension login
- **Quick jump to account settings** – click either status bar meter to open that service's settings page
- Shows **last 5 hours** and **last 7 days** in the status bar
- Displays **USD spend** for API-key based accounts and **percentage utilization** for OAuth/session-based accounts
- Shows clear states for **Please log in**, **loading**, **No usage yet**, and **error**
- Tooltip shows detailed breakdown, reset times when available, and refresh timing
- Auto-refreshes every 5 minutes and whenever authentication sessions change

## Requirements

Install at least one of the companion extensions and sign in:

| Extension | Marketplace ID | Purpose |
|-----------|---------------|---------|
| Claude Code | `anthropic.claude-code` | Provides Anthropic authentication |
| ChatGPT | `openai.chatgpt` | Provides OpenAI authentication |

**AI Limits** only shows a status bar item for companion extensions that are installed.
If an installed companion extension is not authenticated, the item stays visible and shows `Please log in`.
If neither companion extension is installed, the extension activates silently with no UI impact.

## Status Bar Format

```
✳ 5h: $0.12 7d: $1.45   ◎ 5h: 3% 7d: 13%
```

Examples of the compact states:

| State | Example |
|------|---------|
| Not logged in | `✳ Please log in` |
| Loading | `✳ ...` |
| No usage in either window yet | `✳ No usage yet` |
| Error | `✳ error` |
| Usage available | `✳ 5h: $0.12 7d: $1.45` or `◎ 5h: 3% 7d: 13%` |

Hover over an item for a detailed tooltip with exact figures, reset times when known, and refresh timing.

Clicking a status bar item opens the corresponding usage/settings page in your browser. VS Code may show a trusted-domain warning the first time you open links to `https://claude.ai` or `https://chatgpt.com`. To avoid future prompts, add those domains once through `Trusted Domains: Manage Trusted Domains`.

## How It Works

1. On startup the extension checks whether `anthropic.claude-code` and/or `openai.chatgpt` are installed.
2. For each installed extension it reads credentials from the same on-disk or keychain locations that extension uses:
   - **Claude Code**: reads the macOS Keychain entry for service `"Claude Code-credentials"` (account = `$USER`). Falls back to `~/.claude/.credentials.json` on non-macOS systems or if the keychain is unavailable.
   - **Codex / ChatGPT**: reads `~/.codex/auth.json` (or `$CODEX_HOME/auth.json`).
3. The extension resolves usage data from the most reliable source available:
   - **Claude API key auth**: `GET https://api.anthropic.com/v1/usage` with `start_time` / `end_time`
   - **Claude OAuth auth**: `GET https://api.anthropic.com/api/oauth/usage` for 5-hour and 7-day utilization percentages
   - **OpenAI API key auth**: `GET https://api.openai.com/v1/usage?date=YYYY-MM-DD` plus `GET /v1/dashboard/billing/subscription`
   - **Codex ChatGPT OAuth auth**: reads the latest local Codex session rollout (`~/.codex/sessions/**/rollout-*.jsonl`) and uses the embedded `rate_limits` snapshot (`300` minute and `10080` minute windows)
4. The status bar renders one of four compact states per provider:
   - `Please log in` when the companion extension is installed but no usable credentials are found
   - `...` while data is being loaded
   - `No usage yet` when both usage windows are currently empty or unavailable
   - Usage values when at least one window is available
5. Results are cached by token, refreshed every 5 minutes, and refreshed again when VS Code reports extension or authentication changes.

## Known Limitations

### Claude fallback behavior

When the Claude APIs do not provide usable usage data, the extension falls back to local Claude project JSONL files where possible. This fallback can estimate USD usage for API-key based workflows, but it does not help OAuth percentage mode when no percentage snapshot is available.

### 5-hour window (OpenAI API key mode)

OpenAI's usage endpoint returns data aggregated by UTC calendar day. The 5-hour figure is pro-rated from today's usage based on the elapsed fraction of the day, so it is an approximation.

### OAuth and session-based modes

When authenticated through Claude OAuth or ChatGPT/Codex OAuth, the extension shows **percentage utilization** for the 5-hour and 7-day windows instead of USD spend.

For Codex, those percentages come from the latest local rollout snapshot. Older snapshots are intentionally ignored once they are too stale, so the UI may show `No usage yet` rather than a misleading old value.

### Trusted-domain prompts

When you click a status bar item, the extension uses VS Code's standard external-link handling to open the service's usage page. VS Code may ask you to trust `https://claude.ai` and `https://chatgpt.com` before opening them. This trust list is controlled by VS Code rather than by the extension, so the prompt cannot be suppressed automatically.

If you want to stop seeing that warning, run `Trusted Domains: Manage Trusted Domains` from the Command Palette and add:

- `https://claude.ai`
- `https://chatgpt.com`

### Cost estimation

When the API response does not include a pre-computed cost field, costs are estimated using hardcoded list pricing:

| Service | Model assumed | Input | Output |
|---------|--------------|-------|--------|
| Anthropic | Claude 3.5 Sonnet | $3 / 1M tokens | $15 / 1M tokens |
| OpenAI | GPT-4o | $5 / 1M tokens | $15 / 1M tokens |

Actual costs may differ if you use other models or have negotiated pricing.

## Testing

The quickest manual check is to press `F5` in this repo and use the Extension Development Host:

1. Install the companion extension you want to test.
2. Sign out to verify `Please log in`.
3. Sign in and wait for a refresh to verify live usage formatting.
4. Use an account or environment with no current usage window data to verify `No usage yet`.

Automated coverage for the status bar states lives in `test/suite/statusBarManager.test.ts`.

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
    claudeProvider.ts   Reads Claude credentials, then uses API and local fallbacks
    openaiProvider.ts   Reads Codex credentials, then uses API or rollout snapshots
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
