/**
 * Retrieves Codex/OpenAI usage budgets by reading credentials directly
 * from the storage locations used by the `openai.chatgpt` extension.
 *
 * The openai.chatgpt extension does NOT register a VS Code authentication
 * provider.  It communicates with a local Codex agent daemon (bin/codex) via
 * a Unix IPC socket, and that agent persists credentials in:
 *
 *   `~/.codex/auth.json` (or `$CODEX_HOME/auth.json`)
 *
 * The JSON file contains an `OPENAI_API_KEY` field which is used directly
 * with OpenAI's API.
 *
 * NOTE: OpenAI's /v1/usage endpoint is a legacy dashboard endpoint that
 * returns data aggregated by UTC calendar day, so the 5-hour figure is
 * pro-rated from today's usage.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { BudgetInfo, ProviderStatus, UsagePeriod } from '../types';

const EXTENSION_ID = 'openai.chatgpt';
const API_BASE = 'https://api.openai.com';

/** Approximate cost per 1 000 tokens (GPT-4o list pricing). */
const COST_PER_1K_INPUT = 0.005;
const COST_PER_1K_OUTPUT = 0.015;

/** Shape of the Codex auth credentials file. */
interface CodexAuth {
  OPENAI_API_KEY?: string;
  tokens?: { access_token?: string };
}

interface CodexSessionEvent {
  type?: string;
  payload?: {
    type?: string;
    rate_limits?: CodexRateLimitSnapshot;
  };
}

interface CodexRateLimitSnapshot {
  primary?: { used_percent?: number; window_minutes?: number | null };
  secondary?: { used_percent?: number; window_minutes?: number | null };
}

/** Shape of the OpenAI usage API response (legacy dashboard endpoint). */
interface OpenAIUsageResponse {
  object?: string;
  data?: Array<{
    aggregation_timestamp?: number;
    n_context_tokens_total?: number;
    n_generated_tokens_total?: number;
  }>;
}

/** Shape of the OpenAI billing subscription response. */
interface OpenAISubscriptionResponse {
  hard_limit_usd?: number;
  soft_limit_usd?: number;
}

export class OpenAIProvider {
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
   * Reads the API key from the auth credentials file in the Codex home
   * directory (`~/.codex/` or `$CODEX_HOME/`).
   * Returns undefined if the file is absent or contains no usable key.
   */
  resolveToken(): string | undefined {
    const codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
    const authFile = path.join(codexHome, 'auth.json');
    try {
      const raw = fs.readFileSync(authFile, 'utf8');
      const auth = JSON.parse(raw) as CodexAuth;
      if (auth?.OPENAI_API_KEY) return auth.OPENAI_API_KEY;
      if (auth?.tokens?.access_token) return auth.tokens.access_token;
    } catch {
      // File absent or parse error.
    }
    return undefined;
  }

  async fetchBudget(accessToken: string): Promise<BudgetInfo> {
    // JWT tokens (Codex OAuth auth_mode) are not valid OpenAI Platform API
    // keys. Use locally cached rate-limit windows as a fallback.
    if (isJwt(accessToken)) {
      return this.readBudgetFromCodexSessions() ?? { fiveHour: null, oneWeek: null };
    }

    const now = new Date();
    const fiveHoursAgo = new Date(now.getTime() - 5 * 60 * 60 * 1000);
    const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const [subscription, fiveHour, oneWeek] = await Promise.all([
      this.fetchSubscription(accessToken),
      this.fetchPeriod(accessToken, fiveHoursAgo, now),
      this.fetchPeriod(accessToken, oneWeekAgo, now),
    ]);

    return {
      fiveHour: fiveHour === null
        ? null
        : { ...fiveHour, limit: subscription?.softLimit ?? null, unit: 'usd' },
      oneWeek: oneWeek === null
        ? null
        : { ...oneWeek, limit: subscription?.hardLimit ?? null, unit: 'usd' },
    };
  }

  private readBudgetFromCodexSessions(): BudgetInfo | null {
    const codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
    const sessionsRoot = path.join(codexHome, 'sessions');
    const latestRollout = findLatestRolloutFile(sessionsRoot);
    if (!latestRollout) return null;

    try {
      const raw = fs.readFileSync(latestRollout, 'utf8');
      return parseCodexRateLimitsFromRollout(raw);
    } catch {
      return null;
    }
  }

  private async fetchPeriod(
    token: string,
    start: Date,
    end: Date
  ): Promise<UsagePeriod | null> {
    const days = collectDays(start, end);
    let totalCost = 0;

    await Promise.all(
      days.map(async (dateStr) => {
        const url = `${API_BASE}/v1/usage?date=${dateStr}`;
        const response = await fetch(url, { headers: buildHeaders(token) });
        if (!response.ok) {
          // 401/403/404 means the key lacks usage API access – treat as
          // unavailable rather than an error.
          if ([401, 403, 404].includes(response.status)) {
            return;
          }
          throw new Error(`OpenAI API ${response.status}: ${await response.text()}`);
        }
        const data = (await response.json()) as OpenAIUsageResponse;
        totalCost += extractOpenAICost(data, dateStr, start, end);
      })
    );

    return { used: totalCost, limit: null };
  }

  private async fetchSubscription(
    token: string
  ): Promise<{ softLimit: number | null; hardLimit: number | null } | null> {
    try {
      const url = `${API_BASE}/v1/dashboard/billing/subscription`;
      const response = await fetch(url, { headers: buildHeaders(token) });
      if (!response.ok) return null;
      const data = (await response.json()) as OpenAISubscriptionResponse;
      return {
        softLimit: data.soft_limit_usd ?? null,
        hardLimit: data.hard_limit_usd ?? null,
      };
    } catch {
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function notAvailable(): ProviderStatus {
  return { available: false, authenticated: false, budget: null, error: null };
}

/** Returns true when the token is a JWT (Codex OAuth) rather than an API key. */
function isJwt(token: string): boolean {
  return token.startsWith('eyJ');
}

function buildHeaders(token: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };
}

/**
 * Returns an array of YYYY-MM-DD date strings covering all calendar days that
 * overlap with [start, end).
 */
export function collectDays(start: Date, end: Date): string[] {
  const days: string[] = [];
  const cursor = new Date(start);
  cursor.setUTCHours(0, 0, 0, 0);
  const endDay = new Date(end);
  endDay.setUTCHours(0, 0, 0, 0);

  while (cursor <= endDay) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

/**
 * Converts an OpenAI usage response to an approximate USD cost.
 * For partial days the cost is pro-rated by the fraction of that day that
 * falls within [periodStart, periodEnd].
 */
export function extractOpenAICost(
  data: OpenAIUsageResponse,
  dateStr: string,
  periodStart: Date,
  periodEnd: Date
): number {
  if (!Array.isArray(data.data) || data.data.length === 0) {
    return 0;
  }

  const dayStart = new Date(`${dateStr}T00:00:00.000Z`);
  const dayEnd = new Date(`${dateStr}T23:59:59.999Z`);

  const overlapStart = periodStart > dayStart ? periodStart : dayStart;
  const overlapEnd = periodEnd < dayEnd ? periodEnd : dayEnd;
  const dayMs = 24 * 60 * 60 * 1000;
  const ratio = Math.max(0, (overlapEnd.getTime() - overlapStart.getTime()) / dayMs);

  let dayCost = 0;
  for (const entry of data.data) {
    const inputCost = ((entry.n_context_tokens_total ?? 0) / 1000) * COST_PER_1K_INPUT;
    const outputCost = ((entry.n_generated_tokens_total ?? 0) / 1000) * COST_PER_1K_OUTPUT;
    dayCost += inputCost + outputCost;
  }

  return dayCost * ratio;
}

function findLatestRolloutFile(root: string): string | null {
  if (!fs.existsSync(root)) return null;

  const stack: string[] = [root];
  let latestPath: string | null = null;
  let latestMtime = 0;

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
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) {
        continue;
      }
      let stat: fs.Stats;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        continue;
      }
      const mtime = stat.mtimeMs;
      if (mtime > latestMtime) {
        latestMtime = mtime;
        latestPath = fullPath;
      }
    }
  }

  return latestPath;
}

export function parseCodexRateLimitsFromRollout(raw: string): BudgetInfo | null {
  const lines = raw.split('\n').filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index--) {
    try {
      const event = JSON.parse(lines[index]) as CodexSessionEvent;
      if (event.type !== 'event_msg' || event.payload?.type !== 'token_count') {
        continue;
      }
      const snapshot = event.payload.rate_limits;
      if (!snapshot) continue;

      const windows = [snapshot.primary, snapshot.secondary]
        .filter((window): window is { used_percent?: number; window_minutes?: number | null } => Boolean(window))
        .filter((window) => typeof window.window_minutes === 'number');

      if (windows.length === 0) continue;

      const fiveHourWindow = pickRateLimitWindow(windows, 300);
      const oneWeekWindow = pickRateLimitWindow(windows, 10080);

      return {
        fiveHour: toPercentPeriod(fiveHourWindow),
        oneWeek: toPercentPeriod(oneWeekWindow),
      };
    } catch {
      // Ignore malformed lines and keep searching backward.
    }
  }
  return null;
}

function pickRateLimitWindow(
  windows: Array<{ used_percent?: number; window_minutes?: number | null }>,
  targetMinutes: number
): { used_percent?: number; window_minutes?: number | null } | null {
  let best: { used_percent?: number; window_minutes?: number | null } | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const window of windows) {
    const duration = window.window_minutes;
    if (typeof duration !== 'number') continue;
    const distance = Math.abs(duration - targetMinutes);
    if (distance < bestDistance) {
      best = window;
      bestDistance = distance;
    }
  }

  return best;
}

function toPercentPeriod(
  window: { used_percent?: number; window_minutes?: number | null } | null
): UsagePeriod | null {
  if (!window || typeof window.used_percent !== 'number') {
    return null;
  }
  return {
    used: window.used_percent,
    limit: 100,
    unit: 'percent',
  };
}
