import * as assert from 'assert';
import * as vscode from 'vscode';
import * as sinon from 'sinon';
import { StatusBarManager } from '../../src/statusBarManager';
import { ProviderStatus } from '../../src/types';

suite('StatusBarManager', () => {
  let manager: StatusBarManager;
  let claudeItem: FakeStatusBarItem;
  let openaiItem: FakeStatusBarItem;
  let createStub: sinon.SinonStub;

  setup(() => {
    claudeItem = new FakeStatusBarItem();
    openaiItem = new FakeStatusBarItem();

    let callCount = 0;
    createStub = sinon.stub(vscode.window, 'createStatusBarItem').callsFake(() => {
      return callCount++ === 0
        ? (claudeItem as unknown as vscode.StatusBarItem)
        : (openaiItem as unknown as vscode.StatusBarItem);
    });

    manager = new StatusBarManager('ai-limits.showOutput');
  });

  teardown(() => {
    createStub.restore();
    manager.dispose();
  });

  // -------------------------------------------------------------------------
  // updateClaude
  // -------------------------------------------------------------------------

  test('hides Claude item when extension is not available', () => {
    const status: ProviderStatus = notAvailable();
    manager.updateClaude(status);
    assert.ok(claudeItem.hidden, 'item should be hidden');
  });

  test('shows sign-in prompt when Claude is not authenticated', () => {
    manager.updateClaude({ available: true, authenticated: false, budget: null, error: null });
    assert.ok(!claudeItem.hidden);
    assert.ok(claudeItem.text.includes('sign in'), `expected "sign in" in "${claudeItem.text}"`);
  });

  test('shows error state when Claude has an error', () => {
    manager.updateClaude({ available: true, authenticated: true, budget: null, error: 'timeout' });
    assert.ok(!claudeItem.hidden);
    assert.ok(claudeItem.text.includes('error'), `expected "error" in "${claudeItem.text}"`);
  });

  test('shows budget amounts when Claude is fully loaded', () => {
    manager.updateClaude({
      available: true,
      authenticated: true,
      error: null,
      budget: {
        fiveHour: { used: 0.1234, limit: null },
        oneWeek: { used: 1.5678, limit: 10 },
      },
    });
    assert.ok(!claudeItem.hidden);
    assert.ok(claudeItem.text.includes('0.12'), `"5h" cost in "${claudeItem.text}"`);
    assert.ok(claudeItem.text.includes('1.57'), `"7d" cost in "${claudeItem.text}"`);
  });

  test('shows loading spinner when budget is null but authenticated', () => {
    manager.updateClaude({ available: true, authenticated: true, budget: null, error: null });
    assert.ok(!claudeItem.hidden);
    assert.ok(claudeItem.text.includes('sync~spin') || claudeItem.text.includes('Claude'));
  });

  // -------------------------------------------------------------------------
  // updateOpenAI
  // -------------------------------------------------------------------------

  test('hides OpenAI item when extension is not available', () => {
    manager.updateOpenAI(notAvailable());
    assert.ok(openaiItem.hidden, 'item should be hidden');
  });

  test('shows budget amounts when OpenAI is fully loaded', () => {
    manager.updateOpenAI({
      available: true,
      authenticated: true,
      error: null,
      budget: {
        fiveHour: { used: 0.05, limit: null },
        oneWeek: { used: 3.0, limit: 20 },
      },
    });
    assert.ok(!openaiItem.hidden);
    assert.ok(openaiItem.text.includes('0.05'), `5h cost in "${openaiItem.text}"`);
    assert.ok(openaiItem.text.includes('3.00'), `7d cost in "${openaiItem.text}"`);
  });

  test('shows percent format when periods are rate-limit percentages', () => {
    manager.updateOpenAI({
      available: true,
      authenticated: true,
      error: null,
      budget: {
        fiveHour: { used: 3, limit: 100, unit: 'percent' },
        oneWeek: { used: 13, limit: 100, unit: 'percent' },
      },
    });
    assert.ok(openaiItem.text.includes('5h:3%'), `5h percent in "${openaiItem.text}"`);
    assert.ok(openaiItem.text.includes('7d:13%'), `7d percent in "${openaiItem.text}"`);
  });

  // -------------------------------------------------------------------------
  // dispose
  // -------------------------------------------------------------------------

  test('dispose calls dispose on both items', () => {
    manager.dispose();
    assert.ok(claudeItem.disposed, 'claude item should be disposed');
    assert.ok(openaiItem.disposed, 'openai item should be disposed');
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function notAvailable(): ProviderStatus {
  return { available: false, authenticated: false, budget: null, error: null };
}

class FakeStatusBarItem {
  text = '';
  tooltip: string | vscode.MarkdownString = '';
  hidden = true;
  disposed = false;

  show() { this.hidden = false; }
  hide() { this.hidden = true; }
  dispose() { this.disposed = true; }
}
