import * as assert from 'assert';
import * as vscode from 'vscode';
import * as sinon from 'sinon';
import childProcess = require('child_process');
import fs = require('fs');
import { ClaudeProvider, estimateClaudeUsageFromJsonl, extractToken } from '../../src/providers/claudeProvider';
import { tokenKey, CACHE_TTL_MS, CACHE_PATH } from '../../src/sharedCache';

const EXTENSION_ID = 'anthropic.claude-code';

suite('ClaudeProvider', () => {
  let provider: ClaudeProvider;
  let getExtensionStub: sinon.SinonStub;
  let execSyncStub: sinon.SinonStub;
  let readFileSyncStub: sinon.SinonStub;
  let existsSyncStub: sinon.SinonStub;
  let readdirSyncStub: sinon.SinonStub;
  let fetchStub: sinon.SinonStub;
  let writeFileSyncStub: sinon.SinonStub;

  setup(() => {
    provider = new ClaudeProvider();
    getExtensionStub = sinon.stub(vscode.extensions, 'getExtension');
    execSyncStub = sinon.stub(childProcess, 'execSync');
    readFileSyncStub = sinon.stub(fs, 'readFileSync');
    existsSyncStub = sinon.stub(fs, 'existsSync');
    readdirSyncStub = sinon.stub(fs, 'readdirSync');
    writeFileSyncStub = sinon.stub(fs, 'writeFileSync');
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
    assert.strictEqual(status.authenticated, false);
  });

  // -------------------------------------------------------------------------
  // getStatus – authentication
  // -------------------------------------------------------------------------

  test('returns not-authenticated when no credentials are found', async () => {
    getExtensionStub.withArgs(EXTENSION_ID).returns(fakeExtension());
    execSyncStub.throws(new Error('not found'));
    readFileSyncStub.throws(new Error('ENOENT'));

    const status = await provider.getStatus();
    assert.strictEqual(status.available, true);
    assert.strictEqual(status.authenticated, false);
    assert.strictEqual(status.budget, null);
  });

  test('reads OAuth token from credentials file and shows authenticated', async () => {
    getExtensionStub.withArgs(EXTENSION_ID).returns(fakeExtension());
    readFileSyncStub.returns(JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-test' } }));
    fetchStub.resolves(fakeResponse({ data: [] }));

    const status = await provider.getStatus();
    assert.strictEqual(status.available, true);
    assert.strictEqual(status.authenticated, true);
  });

  test('falls back to credential file when keychain throws', async () => {
    getExtensionStub.withArgs(EXTENSION_ID).returns(fakeExtension());
    execSyncStub.throws(new Error('keychain unavailable'));
    readFileSyncStub.returns(JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-file' } }));
    fetchStub.resolves(fakeResponse({ data: [] }));

    const status = await provider.getStatus();
    assert.strictEqual(status.authenticated, true);
  });

  test('returns error state when API call fails', async () => {
    getExtensionStub.withArgs(EXTENSION_ID).returns(fakeExtension());
    readFileSyncStub.returns(JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-test' } }));
    fetchStub.rejects(new Error('Server error'));

    const status = await provider.getStatus();
    assert.strictEqual(status.authenticated, true);
    assert.ok(status.error !== null, 'should have error');
  });

  // -------------------------------------------------------------------------
  // fetchBudget – cost extraction
  // -------------------------------------------------------------------------

  test('uses pre-computed total_cost from API response', async () => {
    fetchStub.resolves(fakeResponse({ total_cost: 2.5 }));
    const budget = await provider.fetchBudget('sk-ant-api03-test');
    assert.ok(budget.fiveHour !== null);
    assert.strictEqual(budget.fiveHour!.used, 2.5);
  });

  test('uses cost from data array entries', async () => {
    fetchStub.resolves(fakeResponse({ data: [{ cost: 1.25 }, { cost: 0.75 }] }));
    const budget = await provider.fetchBudget('sk-ant-api03-test');
    assert.ok(budget.fiveHour !== null);
    assert.ok(Math.abs(budget.fiveHour!.used - 2.0) < 0.001);
  });

  test('estimates cost from token counts when no cost field', async () => {
    // 1M input × $3 + 0.5M output × $15 = $3 + $7.5 = $10.50
    fetchStub.resolves(fakeResponse({ data: [{ input_tokens: 1_000_000, output_tokens: 500_000 }] }));
    const budget = await provider.fetchBudget('sk-ant-api03-test');
    assert.ok(budget.fiveHour !== null);
    assert.ok(Math.abs(budget.fiveHour!.used - 10.5) < 0.01);
  });

  test('returns zero cost for empty response', async () => {
    fetchStub.resolves(fakeResponse({}));
    const budget = await provider.fetchBudget('sk-ant-api03-test');
    assert.ok(budget.fiveHour !== null);
    assert.strictEqual(budget.fiveHour!.used, 0);
  });

  test('uses Claude OAuth usage endpoint for 5h/7d utilization percentages', async () => {
    fetchStub.onFirstCall().resolves(
      fakeResponse({
        five_hour: { utilization: 94, resets_at: '2026-02-22T23:00:00.000Z' },
        seven_day: { utilization: 67 },
      })
    );

    const budget = await provider.fetchBudget('sk-ant-oat01-test');
    assert.ok(budget.fiveHour !== null);
    assert.ok(budget.oneWeek !== null);
    assert.strictEqual(budget.fiveHour!.unit, 'percent');
    assert.strictEqual(budget.oneWeek!.unit, 'percent');
    assert.strictEqual(budget.fiveHour!.used, 94);
    assert.strictEqual(budget.fiveHour!.limit, 100);
    assert.strictEqual(budget.oneWeek!.used, 67);
    assert.strictEqual(fetchStub.callCount, 1);
    assert.deepStrictEqual(budget.fiveHour!.resetsAt, new Date('2026-02-22T23:00:00.000Z'));
    assert.strictEqual(budget.oneWeek!.resetsAt, undefined);
  });

  test('falls back to local Claude project JSONL when usage API is unavailable', async () => {
    fetchStub.resolves(fakeResponse({ error: 'forbidden' }, 403));
    existsSyncStub.returns(true);
    readdirSyncStub.returns([fakeDirent('session.jsonl', false)]);
    readFileSyncStub.returns(
      [
        JSON.stringify({
          timestamp: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
          message: {
            role: 'assistant',
            usage: { input_tokens: 100_000, output_tokens: 20_000 },
          },
        }),
        JSON.stringify({
          timestamp: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
          message: {
            role: 'assistant',
            usage: { input_tokens: 150_000, output_tokens: 10_000 },
          },
        }),
      ].join('\n')
    );

    const budget = await provider.fetchBudget('sk-ant-api03-test');
    assert.ok(budget.fiveHour !== null);
    assert.ok(budget.oneWeek !== null);
    assert.strictEqual(budget.fiveHour!.unit, 'usd');
    assert.strictEqual(budget.oneWeek!.unit, 'usd');
    assert.ok(Math.abs(budget.fiveHour!.used - 0.6) < 0.0001);
    assert.ok(Math.abs(budget.oneWeek!.used - 1.2) < 0.0001);
  });
  // -------------------------------------------------------------------------
  // fetchBudget – shared cache
  // -------------------------------------------------------------------------

  test('returns cached budget without hitting the network when cache is fresh', async () => {
    const token = 'sk-ant-oat01-test';
    const key = tokenKey(token);
    const cacheEntry = {
      [key]: {
        fetchedAt: new Date().toISOString(),
        budget: {
          fiveHour: { used: 42, limit: 100, unit: 'percent' },
          oneWeek: { used: 77, limit: 100, unit: 'percent' },
        },
      },
    };
    readFileSyncStub.withArgs(CACHE_PATH, 'utf8').returns(JSON.stringify(cacheEntry));

    const budget = await provider.fetchBudget(token);

    assert.ok(budget.fiveHour !== null);
    assert.strictEqual(budget.fiveHour!.used, 42);
    assert.strictEqual(budget.oneWeek!.used, 77);
    assert.strictEqual(fetchStub.callCount, 0, 'should not call the network');
  });

  test('fetches fresh data and writes cache when cache is stale', async () => {
    const token = 'sk-ant-oat01-test';
    const key = tokenKey(token);
    const staleTime = new Date(Date.now() - CACHE_TTL_MS - 1000).toISOString();
    const cacheEntry = {
      [key]: {
        fetchedAt: staleTime,
        budget: { fiveHour: { used: 1, limit: 100, unit: 'percent' }, oneWeek: null },
      },
    };
    readFileSyncStub.withArgs(CACHE_PATH, 'utf8').returns(JSON.stringify(cacheEntry));
    fetchStub.resolves(fakeResponse({ five_hour: { utilization: 55 }, seven_day: { utilization: 30 } }));

    const budget = await provider.fetchBudget(token);

    assert.strictEqual(budget.fiveHour!.used, 55);
    assert.ok(fetchStub.callCount > 0, 'should call the network');
    assert.ok(writeFileSyncStub.calledOnce, 'should write updated cache');
  });
});

// ---------------------------------------------------------------------------
// extractToken unit tests
// ---------------------------------------------------------------------------

suite('extractToken', () => {
  test('extracts OAuth token from claudeAiOauth field', () => {
    const raw = JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-abc' } });
    assert.strictEqual(extractToken(raw), 'sk-ant-oat01-abc');
  });

  test('extracts direct apiKey field', () => {
    const raw = JSON.stringify({ apiKey: 'sk-ant-api03-xyz' });
    assert.strictEqual(extractToken(raw), 'sk-ant-api03-xyz');
  });

  test('prefers OAuth token over apiKey', () => {
    const raw = JSON.stringify({ claudeAiOauth: { accessToken: 'oauth-token' }, apiKey: 'api-key' });
    assert.strictEqual(extractToken(raw), 'oauth-token');
  });

  test('returns undefined for invalid JSON', () => {
    assert.strictEqual(extractToken('not-json'), undefined);
  });

  test('returns undefined when no token fields present', () => {
    assert.strictEqual(extractToken(JSON.stringify({ foo: 'bar' })), undefined);
  });

  test('returns undefined for empty object', () => {
    assert.strictEqual(extractToken('{}'), undefined);
  });
});

suite('estimateClaudeUsageFromJsonl', () => {
  test('sums assistant usage in 5h and 7d windows', () => {
    const end = new Date('2026-02-22T12:00:00.000Z');
    const fiveHourStart = new Date('2026-02-22T07:00:00.000Z');
    const oneWeekStart = new Date('2026-02-15T12:00:00.000Z');

    const raw = [
      JSON.stringify({
        timestamp: '2026-02-22T11:00:00.000Z',
        message: {
          role: 'assistant',
          usage: { input_tokens: 100_000, output_tokens: 20_000 },
        },
      }),
      JSON.stringify({
        timestamp: '2026-02-20T11:00:00.000Z',
        message: {
          role: 'assistant',
          usage: { input_tokens: 50_000, output_tokens: 10_000 },
        },
      }),
      JSON.stringify({
        timestamp: '2026-02-22T10:00:00.000Z',
        message: {
          role: 'user',
          usage: { input_tokens: 999_999, output_tokens: 999_999 },
        },
      }),
      JSON.stringify({
        timestamp: '2026-02-10T11:00:00.000Z',
        message: {
          role: 'assistant',
          usage: { input_tokens: 999_999, output_tokens: 999_999 },
        },
      }),
      'not-json',
    ].join('\n');

    const result = estimateClaudeUsageFromJsonl(raw, fiveHourStart, oneWeekStart, end);
    assert.ok(result.sawUsage);
    assert.ok(Math.abs(result.fiveHour - 0.6) < 0.0001);
    assert.ok(Math.abs(result.oneWeek - 0.9) < 0.0001);
  });

  test('returns sawUsage=false when no valid assistant usage exists', () => {
    const end = new Date('2026-02-22T12:00:00.000Z');
    const fiveHourStart = new Date('2026-02-22T07:00:00.000Z');
    const oneWeekStart = new Date('2026-02-15T12:00:00.000Z');
    const raw = JSON.stringify({
      timestamp: '2026-02-22T11:00:00.000Z',
      message: { role: 'assistant', usage: { input_tokens: 0, output_tokens: 0 } },
    });

    const result = estimateClaudeUsageFromJsonl(raw, fiveHourStart, oneWeekStart, end);
    assert.strictEqual(result.sawUsage, false);
    assert.strictEqual(result.fiveHour, 0);
    assert.strictEqual(result.oneWeek, 0);
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

function fakeDirent(name: string, isDirectory: boolean): fs.Dirent {
  return {
    name,
    isDirectory: () => isDirectory,
    isFile: () => !isDirectory,
  } as fs.Dirent;
}
