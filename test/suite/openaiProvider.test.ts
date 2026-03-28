import * as assert from 'assert';
import * as vscode from 'vscode';
import * as sinon from 'sinon';
import fs = require('fs');
import {
  OpenAIProvider,
  collectDays,
  extractOpenAICost,
  parseCodexRateLimitsFromRollout,
} from '../../src/providers/openaiProvider';
import { CACHE_PATH, CACHE_TTL_MS, tokenKey } from '../../src/sharedCache';

const EXTENSION_ID = 'openai.chatgpt';

suite('OpenAIProvider', () => {
  let provider: OpenAIProvider;
  let getExtensionStub: sinon.SinonStub;
  let readFileSyncStub: sinon.SinonStub;
  let fetchStub: sinon.SinonStub;
  let writeFileSyncStub: sinon.SinonStub;
  let mkdirSyncStub: sinon.SinonStub;

  setup(() => {
    provider = new OpenAIProvider();
    getExtensionStub = sinon.stub(vscode.extensions, 'getExtension');
    readFileSyncStub = sinon.stub(fs, 'readFileSync');
    writeFileSyncStub = sinon.stub(fs, 'writeFileSync');
    mkdirSyncStub = sinon.stub(fs, 'mkdirSync');
    fetchStub = sinon.stub(global, 'fetch' as keyof typeof global);
  });

  teardown(() => {
    sinon.restore();
  });

  // -------------------------------------------------------------------------
  // getStatus – availability
  // -------------------------------------------------------------------------

  test('returns not-available when extension is not installed', async () => {
    getExtensionStub.withArgs(EXTENSION_ID).returns(undefined);
    const status = await provider.getStatus();
    assert.strictEqual(status.available, false);
  });

  // -------------------------------------------------------------------------
  // getStatus – authentication
  // -------------------------------------------------------------------------

  test('returns not-authenticated when auth.json is absent', async () => {
    getExtensionStub.withArgs(EXTENSION_ID).returns(fakeExtension());
    readFileSyncStub.throws(new Error('ENOENT'));

    const status = await provider.getStatus();
    assert.strictEqual(status.available, true);
    assert.strictEqual(status.authenticated, false);
  });

  test('reads OPENAI_API_KEY from auth.json and shows authenticated', async () => {
    getExtensionStub.withArgs(EXTENSION_ID).returns(fakeExtension());
    readFileSyncStub.returns(JSON.stringify({ OPENAI_API_KEY: 'sk-openai-test' }));
    fetchStub.resolves(fakeResponse({ object: 'list', data: [] }));

    const status = await provider.getStatus();
    assert.strictEqual(status.available, true);
    assert.strictEqual(status.authenticated, true);
  });

  test('falls back to tokens.access_token when OPENAI_API_KEY absent', async () => {
    getExtensionStub.withArgs(EXTENSION_ID).returns(fakeExtension());
    readFileSyncStub.returns(JSON.stringify({ tokens: { access_token: 'bearer-token' } }));
    fetchStub.resolves(fakeResponse({ object: 'list', data: [] }));

    const status = await provider.getStatus();
    assert.strictEqual(status.authenticated, true);
  });

  test('returns error state when usage API call fails', async () => {
    getExtensionStub.withArgs(EXTENSION_ID).returns(fakeExtension());
    readFileSyncStub.returns(JSON.stringify({ OPENAI_API_KEY: 'sk-openai-test' }));
    fetchStub.resolves(fakeResponse({ error: 'Server error' }, 500));

    const status = await provider.getStatus();
    assert.ok(status.error !== null, 'should have error');
  });

  // -------------------------------------------------------------------------
  // resolveToken
  // -------------------------------------------------------------------------

  test('resolveToken returns undefined for invalid JSON in auth.json', () => {
    readFileSyncStub.returns('not-json');
    const token = provider.resolveToken();
    assert.strictEqual(token, undefined);
  });

  test('resolveToken returns undefined for empty auth object', () => {
    readFileSyncStub.returns('{}');
    const token = provider.resolveToken();
    assert.strictEqual(token, undefined);
  });

  test('returns unavailable budget when usage endpoint denies access', async () => {
    fetchStub.callsFake(async (input: unknown) => {
      const url = String(input);
      if (url.includes('/v1/dashboard/billing/subscription')) {
        return fakeResponse({}, 200);
      }
      return fakeResponse({ error: 'forbidden' }, 403);
    });

    const budget = await provider.fetchBudget('sk-openai-test');

    assert.strictEqual(budget.fiveHour, null);
    assert.strictEqual(budget.oneWeek, null);
    assert.strictEqual(writeFileSyncStub.called, false, 'should not cache all-null budgets');
  });

  test('returns cached budget without hitting the network when cache is fresh', async () => {
    const token = 'sk-openai-test';
    const key = tokenKey(token);
    const cacheEntry = {
      [key]: {
        fetchedAt: new Date().toISOString(),
        budget: {
          fiveHour: { used: 1.5, limit: 20, unit: 'usd' },
          oneWeek: { used: 5, limit: 100, unit: 'usd' },
        },
      },
    };
    readFileSyncStub.withArgs(CACHE_PATH, 'utf8').returns(JSON.stringify(cacheEntry));

    const budget = await provider.fetchBudget(token);

    assert.strictEqual(budget.fiveHour!.used, 1.5);
    assert.strictEqual(budget.oneWeek!.used, 5);
    assert.strictEqual(fetchStub.callCount, 0);
  });

  test('fetches fresh data and writes cache when cache is stale', async () => {
    const token = 'sk-openai-test';
    const key = tokenKey(token);
    const staleTime = new Date(Date.now() - CACHE_TTL_MS - 1000).toISOString();
    const cacheEntry = {
      [key]: {
        fetchedAt: staleTime,
        budget: {
          fiveHour: { used: 1, limit: 20, unit: 'usd' },
          oneWeek: null,
        },
      },
    };
    readFileSyncStub.withArgs(CACHE_PATH, 'utf8').returns(JSON.stringify(cacheEntry));
    fetchStub.callsFake(async (input: unknown) => {
      const url = String(input);
      if (url.includes('/v1/dashboard/billing/subscription')) {
        return fakeResponse({ soft_limit_usd: 25, hard_limit_usd: 50 });
      }
      return fakeResponse({ data: [] });
    });

    const budget = await provider.fetchBudget(token);

    assert.strictEqual(budget.fiveHour!.used, 0);
    assert.strictEqual(budget.fiveHour!.limit, 25);
    assert.strictEqual(budget.oneWeek!.limit, 50);
    assert.ok(mkdirSyncStub.calledOnce, 'should ensure cache directory exists');
    assert.ok(writeFileSyncStub.calledOnce, 'should write updated cache');
  });
});

// ---------------------------------------------------------------------------
// collectDays unit tests
// ---------------------------------------------------------------------------

suite('collectDays', () => {
  test('returns a single day when start and end are in the same UTC day', () => {
    const start = new Date('2024-01-15T10:00:00Z');
    const end = new Date('2024-01-15T14:00:00Z');
    assert.deepStrictEqual(collectDays(start, end), ['2024-01-15']);
  });

  test('returns consecutive days spanning a week', () => {
    const start = new Date('2024-01-10T00:00:00Z');
    const end = new Date('2024-01-16T23:59:59Z');
    const days = collectDays(start, end);
    assert.strictEqual(days.length, 7);
    assert.strictEqual(days[0], '2024-01-10');
    assert.strictEqual(days[6], '2024-01-16');
  });
});

// ---------------------------------------------------------------------------
// extractOpenAICost unit tests
// ---------------------------------------------------------------------------

suite('extractOpenAICost', () => {
  test('returns 0 for empty data array', () => {
    const result = extractOpenAICost(
      { data: [] },
      '2024-01-15',
      new Date('2024-01-15T00:00:00Z'),
      new Date('2024-01-15T23:59:59Z')
    );
    assert.strictEqual(result, 0);
  });

  test('calculates cost from token counts for a full day', () => {
    const result = extractOpenAICost(
      { data: [{ n_context_tokens_total: 1000, n_generated_tokens_total: 500 }] },
      '2024-01-15',
      new Date('2024-01-15T00:00:00Z'),
      new Date('2024-01-15T23:59:59Z')
    );
    assert.ok(result > 0, 'cost should be positive');
    assert.ok(result < 0.02, 'cost should be small for this token count');
  });

  test('pro-rates cost for a partial day (first 5 hours)', () => {
    const fullDayCost = extractOpenAICost(
      { data: [{ n_context_tokens_total: 1_000_000, n_generated_tokens_total: 0 }] },
      '2024-01-15',
      new Date('2024-01-15T00:00:00Z'),
      new Date('2024-01-15T23:59:59Z')
    );
    const fiveHourCost = extractOpenAICost(
      { data: [{ n_context_tokens_total: 1_000_000, n_generated_tokens_total: 0 }] },
      '2024-01-15',
      new Date('2024-01-15T00:00:00Z'),
      new Date('2024-01-15T05:00:00Z')
    );
    const ratio = fiveHourCost / fullDayCost;
    assert.ok(ratio > 0.19 && ratio < 0.22, `expected ratio ~5/24 (0.208), got ${ratio}`);
  });

  test('aggregates cost across multiple entries', () => {
    const twoEntries = extractOpenAICost(
      { data: [{ n_context_tokens_total: 500, n_generated_tokens_total: 250 }, { n_context_tokens_total: 500, n_generated_tokens_total: 250 }] },
      '2024-01-15',
      new Date('2024-01-15T00:00:00Z'),
      new Date('2024-01-15T23:59:59Z')
    );
    const oneEntry = extractOpenAICost(
      { data: [{ n_context_tokens_total: 1000, n_generated_tokens_total: 500 }] },
      '2024-01-15',
      new Date('2024-01-15T00:00:00Z'),
      new Date('2024-01-15T23:59:59Z')
    );
    assert.ok(Math.abs(twoEntries - oneEntry) < 0.0001, 'two half-entries should equal one full entry');
  });
});

// ---------------------------------------------------------------------------
// parseCodexRateLimitsFromRollout unit tests
// ---------------------------------------------------------------------------

suite('parseCodexRateLimitsFromRollout', () => {
  test('extracts 5h and 7d percentage windows from a fresh token_count event', () => {
    // Use a snapshot from 1 hour ago so both windows are still within their periods.
    const snapshotTime = new Date(Date.now() - 60 * 60 * 1000);
    const raw = [
      JSON.stringify({
        type: 'event_msg',
        timestamp: snapshotTime.toISOString(),
        payload: {
          type: 'token_count',
          rate_limits: {
            primary: { used_percent: 3, window_minutes: 300 },
            secondary: { used_percent: 13, window_minutes: 10080 },
          },
        },
      }),
    ].join('\n');

    const budget = parseCodexRateLimitsFromRollout(raw);
    assert.ok(budget !== null);
    assert.ok(budget!.fiveHour !== null, 'fiveHour should be present for fresh snapshot');
    assert.ok(budget!.oneWeek !== null, 'oneWeek should be present for fresh snapshot');
    assert.strictEqual(budget!.fiveHour!.used, 3);
    assert.strictEqual(budget!.fiveHour!.limit, 100);
    assert.strictEqual(budget!.fiveHour!.unit, 'percent');
    const expectedFiveHourReset = new Date(snapshotTime.getTime() + 300 * 60_000);
    assert.ok(Math.abs(budget!.fiveHour!.resetsAt!.getTime() - expectedFiveHourReset.getTime()) < 1000);
    assert.strictEqual(budget!.oneWeek!.used, 13);
    assert.strictEqual(budget!.oneWeek!.limit, 100);
    assert.strictEqual(budget!.oneWeek!.unit, 'percent');
    const expectedOneWeekReset = new Date(snapshotTime.getTime() + 10080 * 60_000);
    assert.ok(Math.abs(budget!.oneWeek!.resetsAt!.getTime() - expectedOneWeekReset.getTime()) < 1000);
  });

  test('returns null for 5h window when snapshot is older than half the window duration', () => {
    // Snapshot from 3 hours ago – older than half of 5 hours (2.5h threshold).
    const snapshotTime = new Date(Date.now() - 3 * 60 * 60 * 1000);
    const raw = JSON.stringify({
      type: 'event_msg',
      timestamp: snapshotTime.toISOString(),
      payload: {
        type: 'token_count',
        rate_limits: {
          primary: { used_percent: 80, window_minutes: 300 },
        },
      },
    });

    const budget = parseCodexRateLimitsFromRollout(raw);
    assert.ok(budget !== null);
    // More than half the 5-hour window has elapsed – stale data must not be shown.
    assert.strictEqual(budget!.fiveHour, null, 'fiveHour should be null for snapshot older than half the window');
  });

  test('returns null for 7d window when snapshot is older than half the window duration', () => {
    // Snapshot from 6 days ago – older than half of 7 days (3.5d threshold).
    const snapshotTime = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000);
    const raw = JSON.stringify({
      type: 'event_msg',
      timestamp: snapshotTime.toISOString(),
      payload: {
        type: 'token_count',
        rate_limits: {
          primary: { used_percent: 5, window_minutes: 300 },
          secondary: { used_percent: 90, window_minutes: 10080 },
        },
      },
    });

    const budget = parseCodexRateLimitsFromRollout(raw);
    assert.ok(budget !== null);
    assert.strictEqual(budget!.fiveHour, null, 'fiveHour should be null (6d > 2.5h threshold)');
    assert.strictEqual(budget!.oneWeek, null, 'oneWeek should be null (6d > 3.5d threshold)');
  });

  test('returns null for rollout data without rate limit snapshots', () => {
    const raw = '{"type":"event_msg","payload":{"type":"token_count"}}\n';
    const budget = parseCodexRateLimitsFromRollout(raw);
    assert.strictEqual(budget, null);
  });

  test('uses fallback timestamp when rollout event has no timestamp', () => {
    // Use a recent fallback so the window is still active.
    const fallback = new Date(Date.now() - 30 * 60 * 1000); // 30 minutes ago
    const raw = '{"type":"event_msg","payload":{"type":"token_count","rate_limits":{"primary":{"used_percent":20,"window_minutes":300}}}}\n';

    const budget = parseCodexRateLimitsFromRollout(raw, fallback);

    assert.ok(budget!.fiveHour !== null, 'fiveHour should be present for recent fallback');
    const expectedReset = new Date(fallback.getTime() + 300 * 60_000);
    assert.ok(Math.abs(budget!.fiveHour!.resetsAt!.getTime() - expectedReset.getTime()) < 1000);
  });

  test('prefers the rollout resets_at timestamp when present', () => {
    const snapshotTime = new Date(Date.now() - 60 * 60 * 1000);
    const explicitReset = Math.floor((Date.now() + 42 * 60 * 1000) / 1000);
    const raw = JSON.stringify({
      type: 'event_msg',
      timestamp: snapshotTime.toISOString(),
      payload: {
        type: 'token_count',
        rate_limits: {
          primary: { used_percent: 20, window_minutes: 300, resets_at: explicitReset },
        },
      },
    });

    const budget = parseCodexRateLimitsFromRollout(raw);

    assert.ok(budget?.fiveHour?.resetsAt);
    assert.strictEqual(
      budget!.fiveHour!.resetsAt!.getTime(),
      explicitReset * 1000
    );
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fakeExtension(): Partial<vscode.Extension<unknown>> {
  return { exports: {} };
}

function fakeResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}
