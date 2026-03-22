/**
 * Retrieves Claude/Anthropic usage budgets by reading credentials directly
 * from the storage locations used by the `anthropic.claude-code` extension.
 *
 * The claude-code extension does NOT register a VS Code authentication
 * provider.  It stores credentials in two places (tried in order):
 *  1. macOS Keychain – service "Claude Code-credentials", account = $USER
 *     The value is a JSON blob with a `claudeAiOauth.accessToken` field
 *     (OAuth token) or an `apiKey` field (direct Anthropic API key).
 *  2. File fallback  – ~/.claude/.credentials.json (same JSON structure).
 *
 * The resolved token is then used as a Bearer token (OAuth) or x-api-key
 * header (API key starting with "sk-ant-api") to call Anthropic's usage API.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import * as vscode from 'vscode';
import { BudgetInfo, ProviderStatus, UsagePeriod } from '../types';
import { fetchWithRetry } from '../fetchWithRetry';
import { readCache, writeCache, tokenKey } from '../sharedCache';

const EXTENSION_ID = 'anthropic.claude-code';
const API_BASE = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';
const OAUTH_BETA = 'oauth-2025-04-20';

/** The macOS Keychain service name used by claude-code. */
const KEYCHAIN_SERVICE = 'Claude Code-credentials';

/** Shape of the JSON blob stored in the Keychain / credentials file. */
interface ClaudeCredentials {
  claudeAiOauth?: { accessToken?: string };
  apiKey?: string;
}

/** Shape of the Anthropic usage API response we care about. */
interface AnthropicUsageResponse {
  data?: Array<{
    input_tokens?: number;
    output_tokens?: number;
    cost?: number;
  }>;
  total_cost?: number;
}

interface ClaudeOAuthUsageWindow {
  utilization?: number | null;
  resets_at?: string;
}

interface ClaudeOAuthUsageResponse {
  five_hour?: ClaudeOAuthUsageWindow;
  seven_day?: ClaudeOAuthUsageWindow;
}

interface ClaudeProjectUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

interface ClaudeProjectEvent {
  timestamp?: string;
  message?: {
    role?: string;
    usage?: ClaudeProjectUsage;
  };
}

export class ClaudeProvider {
  async getStatus(): Promise<ProviderStatus> {
    if (!vscode.extensions.getExtension(EXTENSION_ID)) {
      return notAvailable();
    }

    const token = this.resolveToken();
    if (token === undefined) {
      return { available: true, authenticated: false, budget: null, error: null };
    }

    try {
      const budget = await this.fetchBudget(token);
      return { available: true, authenticated: true, budget, error: null };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { available: true, authenticated: true, budget: null, error: message };
    }
  }

  /**
   * Reads the stored token from the macOS Keychain or the credential file.
   * Returns undefined if no credential is found.
   */
  resolveToken(): string | undefined {
    // 1. macOS Keychain
    if (process.platform === 'darwin') {
      try {
        const account = process.env.USER ?? os.userInfo().username;
        const raw = execSync(
          `security find-generic-password -a "${account}" -w -s "${KEYCHAIN_SERVICE}"`,
          { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
        ).trim();
        const token = extractToken(raw);
        if (token) return token;
      } catch {
        // Keychain entry not found or access denied – fall through.
      }
    }

    // 2. File-based fallback: ~/.claude/.credentials.json
    const credFile = path.join(os.homedir(), '.claude', '.credentials.json');
    try {
      const raw = fs.readFileSync(credFile, 'utf8');
      const token = extractToken(raw);
      if (token) return token;
    } catch {
      // File absent or unreadable – fall through.
    }

    return undefined;
  }

  async fetchBudget(accessToken: string): Promise<BudgetInfo> {
    const key = tokenKey(accessToken);
    const cached = readCache(key);
    if (cached !== null) {
      return cached;
    }

    const budget = await this.fetchFreshBudget(accessToken);
    writeCache(key, budget);
    return budget;
  }

  private async fetchFreshBudget(accessToken: string): Promise<BudgetInfo> {
    const isOAuthToken = accessToken.startsWith('sk-ant-oat');

    // OAuth tokens surface percentage utilization via a dedicated endpoint.
    // If that endpoint is unavailable we return no data — the JSONL cost
    // estimates are meaningless for subscription users who see percentages.
    if (isOAuthToken) {
      return (await this.fetchOAuthUsage(accessToken)) ?? { fiveHour: null, oneWeek: null };
    }

    const now = new Date();
    const fiveHoursAgo = new Date(now.getTime() - 5 * 60 * 60 * 1000);
    const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const [fiveHour, oneWeek] = await Promise.all([
      this.fetchPeriod(accessToken, fiveHoursAgo, now),
      this.fetchPeriod(accessToken, oneWeekAgo, now),
    ]);

    if (fiveHour === null && oneWeek === null) {
      const fallback = this.readBudgetFromClaudeProjects(fiveHoursAgo, oneWeekAgo, now);
      if (fallback) return fallback;
    }

    return { fiveHour, oneWeek };
  }

  private async fetchOAuthUsage(accessToken: string): Promise<BudgetInfo | null> {
    // Claude Code OAuth tokens can access a dedicated endpoint that returns
    // the same 5h/7d utilization percentages shown in Claude.
    if (!accessToken.startsWith('sk-ant-oat')) {
      return null;
    }

    const url = `${API_BASE}/api/oauth/usage`;
    const response = await fetchWithRetry(url, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
        'anthropic-beta': OAUTH_BETA,
      },
    });

    if (!response.ok) {
      // Any non-success (including 429 rate-limit) falls through to the
      // standard usage API or local-file fallback rather than surfacing an error.
      return null;
    }

    const data = (await response.json()) as ClaudeOAuthUsageResponse;
    const fiveHour = extractOAuthUsagePeriod(data.five_hour);
    const oneWeek = extractOAuthUsagePeriod(data.seven_day);
    if (fiveHour === null && oneWeek === null) {
      return null;
    }

    return { fiveHour, oneWeek };
  }

  private readBudgetFromClaudeProjects(
    fiveHoursAgo: Date,
    oneWeekAgo: Date,
    now: Date
  ): BudgetInfo | null {
    const projectRoot = path.join(os.homedir(), '.claude', 'projects');
    if (!fs.existsSync(projectRoot)) return null;

    const files = collectJsonlFiles(projectRoot);
    if (files.length === 0) return null;

    let fiveHourCost = 0;
    let oneWeekCost = 0;
    let sawUsage = false;

    for (const file of files) {
      let raw: string;
      try {
        raw = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }

      const parsed = estimateClaudeUsageFromJsonl(raw, fiveHoursAgo, oneWeekAgo, now);
      fiveHourCost += parsed.fiveHour;
      oneWeekCost += parsed.oneWeek;
      sawUsage ||= parsed.sawUsage;
    }

    if (!sawUsage) return null;

    return {
      fiveHour: { used: fiveHourCost, limit: null, unit: 'usd' },
      oneWeek: { used: oneWeekCost, limit: null, unit: 'usd' },
    };
  }

  private async fetchPeriod(
    token: string,
    start: Date,
    end: Date
  ): Promise<UsagePeriod | null> {
    const params = new URLSearchParams({
      start_time: start.toISOString(),
      end_time: end.toISOString(),
    });

    const url = `${API_BASE}/v1/usage?${params.toString()}`;
    const response = await fetchWithRetry(url, { headers: buildHeaders(token) });

    if (!response.ok) {
      // Any non-success (including 429 rate-limit) falls through to the
      // local-file fallback rather than surfacing an error.
      return null;
    }

    const data = (await response.json()) as AnthropicUsageResponse;
    return { used: extractAnthropicCost(data), limit: null };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function notAvailable(): ProviderStatus {
  return { available: false, authenticated: false, budget: null, error: null };
}

/**
 * Parses a JSON credential blob and returns the access token or API key.
 * Exported for testing.
 */
export function extractToken(raw: string): string | undefined {
  try {
    const creds = JSON.parse(raw) as ClaudeCredentials;
    const oauthToken = creds?.claudeAiOauth?.accessToken;
    if (oauthToken) return oauthToken;
    if (creds?.apiKey) return creds.apiKey;
  } catch {
    // Not valid JSON – ignore.
  }
  return undefined;
}

function buildHeaders(token: string): Record<string, string> {
  // Direct API keys look like "sk-ant-api03-…"; OAuth tokens "sk-ant-oat01-…"
  const isApiKey = token.startsWith('sk-ant-api');
  return {
    'Content-Type': 'application/json',
    'anthropic-version': ANTHROPIC_VERSION,
    ...(isApiKey
      ? { 'x-api-key': token }
      : { Authorization: `Bearer ${token}` }),
  };
}

function extractAnthropicCost(data: AnthropicUsageResponse): number {
  if (typeof data.total_cost === 'number') {
    return data.total_cost;
  }
  if (Array.isArray(data.data)) {
    return data.data.reduce((sum, entry) => {
      if (typeof entry.cost === 'number') {
        return sum + entry.cost;
      }
      // Estimate from token counts (Claude 3.5 Sonnet list pricing).
      const inputCost = ((entry.input_tokens ?? 0) / 1_000_000) * 3.0;
      const outputCost = ((entry.output_tokens ?? 0) / 1_000_000) * 15.0;
      return sum + inputCost + outputCost;
    }, 0);
  }
  return 0;
}

function extractOAuthUsagePeriod(window: ClaudeOAuthUsageWindow | undefined): UsagePeriod | null {
  if (!window || typeof window.utilization !== 'number') {
    return null;
  }

  // Some APIs return 0-1, others return 0-100. Normalize to percent.
  const raw = window.utilization;
  const used = raw <= 1 ? raw * 100 : raw;

  const period: UsagePeriod = { used, limit: 100, unit: 'percent' };
  if (window.resets_at) {
    const resetsAt = new Date(window.resets_at);
    if (!Number.isNaN(resetsAt.getTime())) {
      period.resetsAt = resetsAt;
    }
  }
  return period;
}

function collectJsonlFiles(root: string): string[] {
  const files: string[] = [];
  const stack: string[] = [root];

  while (stack.length > 0) {
    const current = stack.pop()!;
    const entries: fs.Dirent[] = (() => {
      try {
        return fs.readdirSync(current, { withFileTypes: true });
      } catch {
        return [];
      }
    })();
    if (entries.length === 0) continue;

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        files.push(fullPath);
      }
    }
  }

  return files;
}

export function estimateClaudeUsageFromJsonl(
  raw: string,
  fiveHourStart: Date,
  oneWeekStart: Date,
  end: Date
): { fiveHour: number; oneWeek: number; sawUsage: boolean } {
  const lines = raw.split('\n').filter(Boolean);
  let fiveHour = 0;
  let oneWeek = 0;
  let sawUsage = false;

  for (const line of lines) {
    let event: ClaudeProjectEvent;
    try {
      event = JSON.parse(line) as ClaudeProjectEvent;
    } catch {
      continue;
    }

    if (event.message?.role !== 'assistant' || !event.message.usage || !event.timestamp) {
      continue;
    }

    const ts = new Date(event.timestamp);
    if (Number.isNaN(ts.getTime()) || ts > end || ts < oneWeekStart) {
      continue;
    }

    const usage = event.message.usage;
    const cost = estimateClaudeCostFromUsage(usage);
    if (cost <= 0) continue;

    sawUsage = true;
    oneWeek += cost;
    if (ts >= fiveHourStart) {
      fiveHour += cost;
    }
  }

  return { fiveHour, oneWeek, sawUsage };
}

function estimateClaudeCostFromUsage(usage: ClaudeProjectUsage): number {
  const inputTokens = usage.input_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? 0;
  const cacheCreateTokens = usage.cache_creation_input_tokens ?? 0;
  const cacheReadTokens = usage.cache_read_input_tokens ?? 0;

  // Approximate Claude Sonnet list pricing.
  const inputCost = (inputTokens / 1_000_000) * 3.0;
  const outputCost = (outputTokens / 1_000_000) * 15.0;
  const cacheCreateCost = (cacheCreateTokens / 1_000_000) * 3.75;
  const cacheReadCost = (cacheReadTokens / 1_000_000) * 0.30;

  return inputCost + outputCost + cacheCreateCost + cacheReadCost;
}
