import * as assert from 'assert';
import * as sinon from 'sinon';
import fs = require('fs');
import { readCache, writeCache, tokenKey, CACHE_TTL_MS, CACHE_PATH } from '../../src/sharedCache';

suite('sharedCache', () => {
  let readFileSyncStub: sinon.SinonStub;
  let writeFileSyncStub: sinon.SinonStub;
  let mkdirSyncStub: sinon.SinonStub;

  setup(() => {
    readFileSyncStub = sinon.stub(fs, 'readFileSync');
    writeFileSyncStub = sinon.stub(fs, 'writeFileSync');
    mkdirSyncStub = sinon.stub(fs, 'mkdirSync');
  });

  teardown(() => {
    sinon.restore();
  });

  // -------------------------------------------------------------------------
  // tokenKey
  // -------------------------------------------------------------------------

  test('produces a consistent 16-char hex key for the same token', () => {
    const key = tokenKey('sk-ant-oat01-abc');
    assert.strictEqual(key.length, 16);
    assert.strictEqual(key, tokenKey('sk-ant-oat01-abc'));
  });

  test('produces different keys for different tokens', () => {
    assert.notStrictEqual(tokenKey('sk-ant-oat01-abc'), tokenKey('sk-ant-oat01-xyz'));
  });

  // -------------------------------------------------------------------------
  // readCache – miss cases
  // -------------------------------------------------------------------------

  test('returns null when cache file does not exist', () => {
    readFileSyncStub.throws(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    assert.strictEqual(readCache('somekey'), null);
  });

  test('returns null when cache file contains invalid JSON', () => {
    readFileSyncStub.returns('not-json');
    assert.strictEqual(readCache('somekey'), null);
  });

  test('returns null when the key is absent from the cache file', () => {
    readFileSyncStub.returns(JSON.stringify({ other_key: { fetchedAt: new Date().toISOString(), budget: { fiveHour: null, oneWeek: null } } }));
    assert.strictEqual(readCache('somekey'), null);
  });

  test('returns null when the cache entry is stale', () => {
    const staleTime = new Date(Date.now() - CACHE_TTL_MS - 1000).toISOString();
    const file = { mykey: { fetchedAt: staleTime, budget: { fiveHour: { used: 10, limit: 100, unit: 'percent' }, oneWeek: null } } };
    readFileSyncStub.returns(JSON.stringify(file));
    assert.strictEqual(readCache('mykey'), null);
  });

  // -------------------------------------------------------------------------
  // readCache – hit cases
  // -------------------------------------------------------------------------

  test('returns BudgetInfo when cache entry is fresh', () => {
    const file = {
      mykey: {
        fetchedAt: new Date().toISOString(),
        budget: {
          fiveHour: { used: 42, limit: 100, unit: 'percent' },
          oneWeek: { used: 77, limit: 100, unit: 'percent' },
        },
      },
    };
    readFileSyncStub.returns(JSON.stringify(file));

    const result = readCache('mykey');
    assert.ok(result !== null);
    assert.strictEqual(result!.fiveHour!.used, 42);
    assert.strictEqual(result!.oneWeek!.used, 77);
  });

  test('deserializes resetsAt date correctly', () => {
    const resetsAt = '2026-03-22T12:00:00.000Z';
    const file = {
      mykey: {
        fetchedAt: new Date().toISOString(),
        budget: {
          fiveHour: { used: 10, limit: 100, unit: 'percent', resetsAt },
          oneWeek: null,
        },
      },
    };
    readFileSyncStub.returns(JSON.stringify(file));

    const result = readCache('mykey');
    assert.deepStrictEqual(result!.fiveHour!.resetsAt, new Date(resetsAt));
  });

  test('treats all-null budgets as a cache miss', () => {
    const file = {
      mykey: {
        fetchedAt: new Date().toISOString(),
        budget: { fiveHour: null, oneWeek: null },
      },
    };
    readFileSyncStub.returns(JSON.stringify(file));

    assert.strictEqual(readCache('mykey'), null);
  });

  // -------------------------------------------------------------------------
  // writeCache
  // -------------------------------------------------------------------------

  test('writes a cache entry with the correct key and fetchedAt', () => {
    readFileSyncStub.throws(new Error('ENOENT')); // no existing cache

    writeCache('mykey', { fiveHour: { used: 50, limit: 100, unit: 'percent' }, oneWeek: null });

    assert.ok(mkdirSyncStub.calledOnce);
    assert.ok(writeFileSyncStub.calledOnce);
    const [writtenPath, writtenContent] = writeFileSyncStub.firstCall.args as [string, string];
    assert.strictEqual(writtenPath, CACHE_PATH);
    const parsed = JSON.parse(writtenContent) as Record<string, { fetchedAt: string; budget: unknown }>;
    assert.ok('mykey' in parsed);
    assert.ok(typeof parsed['mykey'].fetchedAt === 'string');
  });

  test('merges with existing cache entries', () => {
    const existing = {
      other: { fetchedAt: new Date().toISOString(), budget: { fiveHour: null, oneWeek: null } },
    };
    readFileSyncStub.returns(JSON.stringify(existing));

    writeCache('mykey', { fiveHour: { used: 30, limit: 100, unit: 'percent' }, oneWeek: null });

    const [, writtenContent] = writeFileSyncStub.firstCall.args as [string, string];
    const parsed = JSON.parse(writtenContent) as Record<string, unknown>;
    assert.ok('other' in parsed, 'should preserve existing entries');
    assert.ok('mykey' in parsed, 'should add new entry');
  });

  test('serializes resetsAt date to ISO string', () => {
    readFileSyncStub.throws(new Error('ENOENT'));
    const resetsAt = new Date('2026-03-22T12:00:00.000Z');

    writeCache('mykey', { fiveHour: { used: 10, limit: 100, unit: 'percent', resetsAt }, oneWeek: null });

    const [, writtenContent] = writeFileSyncStub.firstCall.args as [string, string];
    const parsed = JSON.parse(writtenContent) as Record<string, { budget: { fiveHour: { resetsAt: string } } }>;
    assert.strictEqual(parsed['mykey'].budget.fiveHour.resetsAt, resetsAt.toISOString());
  });

  test('does not throw when writeFileSync fails', () => {
    readFileSyncStub.throws(new Error('ENOENT'));
    writeFileSyncStub.throws(new Error('EACCES'));

    assert.doesNotThrow(() => writeCache('mykey', { fiveHour: null, oneWeek: null }));
  });

  test('does not throw when mkdirSync fails', () => {
    readFileSyncStub.throws(new Error('ENOENT'));
    mkdirSyncStub.throws(new Error('EACCES'));

    assert.doesNotThrow(() => writeCache('mykey', { fiveHour: null, oneWeek: null }));
  });

  test('skips writing cache entries when both windows are null', () => {
    writeCache('mykey', { fiveHour: null, oneWeek: null });

    assert.strictEqual(mkdirSyncStub.called, false);
    assert.strictEqual(writeFileSyncStub.called, false);
  });
});
