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

    manager = new StatusBarManager(
      'ai-limits.showOutput',
      'ai-limits.openClaudeSettings',
      'ai-limits.openOpenAISettings'
    );
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

  test('shows login prompt when Claude is not authenticated', () => {
    manager.updateClaude({ available: true, authenticated: false, budget: null, error: null });
    assert.ok(!claudeItem.hidden);
    assert.ok(claudeItem.text.includes('Please log in'), `expected "Please log in" in "${claudeItem.text}"`);
    assert.ok(!claudeItem.text.includes('Claude'), `did not expect full label in "${claudeItem.text}"`);
    assert.strictEqual(claudeItem.command, 'ai-limits.openClaudeSettings');
  });

  test('shows error state when Claude has an error', () => {
    manager.updateClaude({ available: true, authenticated: true, budget: null, error: 'timeout' });
    assert.ok(!claudeItem.hidden);
    assert.ok(claudeItem.text.includes('error'), `expected "error" in "${claudeItem.text}"`);
    assert.ok(!claudeItem.text.includes('Claude'), `did not expect full label in "${claudeItem.text}"`);
    assert.strictEqual(claudeItem.command, 'ai-limits.showOutput');
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
    assert.ok(claudeItem.text.includes('5h: $0.12'), `"5h" cost in "${claudeItem.text}"`);
    assert.ok(claudeItem.text.includes('7d: $1.57'), `"7d" cost in "${claudeItem.text}"`);
    assert.ok(!claudeItem.text.includes('Claude'), `did not expect full label in "${claudeItem.text}"`);
    assert.strictEqual(claudeItem.command, 'ai-limits.openClaudeSettings');
  });

  test('shows loading spinner when budget is null but authenticated', () => {
    manager.updateClaude({ available: true, authenticated: true, budget: null, error: null });
    assert.ok(!claudeItem.hidden);
    assert.ok(claudeItem.text.includes('...'), `expected compact loading state in "${claudeItem.text}"`);
    assert.ok(!claudeItem.text.includes('Claude'), `did not expect full label in "${claudeItem.text}"`);
  });

  test('shows no-usage-yet state when both budget windows are missing', () => {
    manager.updateClaude({
      available: true,
      authenticated: true,
      budget: { fiveHour: null, oneWeek: null },
      error: null,
    });
    assert.ok(!claudeItem.hidden);
    assert.ok(claudeItem.text.includes('No usage yet'), `expected "No usage yet" in "${claudeItem.text}"`);
    assert.ok(!claudeItem.text.includes('Claude'), `did not expect full label in "${claudeItem.text}"`);
    const tooltip = tooltipValue(claudeItem.tooltip);
    assert.ok(tooltip.includes('No usage has been recorded yet'), `unexpected tooltip: ${tooltip}`);
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
    assert.ok(openaiItem.text.includes('5h: $0.05'), `5h cost in "${openaiItem.text}"`);
    assert.ok(openaiItem.text.includes('7d: $3.00'), `7d cost in "${openaiItem.text}"`);
    assert.ok(!openaiItem.text.includes('Codex'), `did not expect full label in "${openaiItem.text}"`);
    assert.strictEqual(openaiItem.command, 'ai-limits.openOpenAISettings');
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
    assert.ok(openaiItem.text.includes('5h: 3%'), `5h percent in "${openaiItem.text}"`);
    assert.ok(openaiItem.text.includes('7d: 13%'), `7d percent in "${openaiItem.text}"`);
    assert.ok(!openaiItem.text.includes('Codex'), `did not expect full label in "${openaiItem.text}"`);
  });

  test('shows whichever budget window is available without falling back to no-usage', () => {
    manager.updateOpenAI({
      available: true,
      authenticated: true,
      error: null,
      budget: {
        fiveHour: null,
        oneWeek: { used: 13, limit: 100, unit: 'percent' },
      },
    });
    assert.ok(!openaiItem.hidden);
    assert.ok(!openaiItem.text.includes('No usage yet'), `did not expect no-usage in "${openaiItem.text}"`);
    assert.ok(!openaiItem.text.includes('5h:'), `did not expect 5h window in "${openaiItem.text}"`);
    assert.ok(openaiItem.text.includes('7d: 13%'), `expected 7d window in "${openaiItem.text}"`);
  });

  test('tooltip shows reset time when resetsAt is provided', () => {
    const resetsAt = new Date(Date.now() + 2 * 60 * 60 * 1000 + 15 * 60 * 1000); // 2h 15m from now
    manager.updateClaude({
      available: true,
      authenticated: true,
      error: null,
      budget: {
        fiveHour: { used: 45, limit: 100, unit: 'percent', resetsAt },
        oneWeek: { used: 10, limit: 100, unit: 'percent' },
      },
    });
    const tooltip = tooltipValue(claudeItem.tooltip);
    assert.ok(tooltip.includes('Resets:'), `expected "Resets:" in tooltip: ${tooltip}`);
    assert.ok(tooltip.includes('in 2h'), `expected relative time in tooltip: ${tooltip}`);
  });

  test('tooltip omits reset time when resetsAt is absent', () => {
    manager.updateClaude({
      available: true,
      authenticated: true,
      error: null,
      budget: {
        fiveHour: { used: 45, limit: 100, unit: 'percent' },
        oneWeek: { used: 10, limit: 100, unit: 'percent' },
      },
    });
    const tooltip = tooltipValue(claudeItem.tooltip);
    assert.ok(!tooltip.includes('Resets:'), `unexpected "Resets:" in tooltip: ${tooltip}`);
  });

  test('tooltips remain untrusted markdown', () => {
    manager.updateClaude({
      available: true,
      authenticated: true,
      error: null,
      budget: {
        fiveHour: { used: 0.5, limit: 10 },
        oneWeek: null,
      },
    });
    assert.ok(claudeItem.tooltip instanceof vscode.MarkdownString);
    assert.strictEqual((claudeItem.tooltip as vscode.MarkdownString).isTrusted, false);
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

function tooltipValue(tooltip: string | vscode.MarkdownString): string {
  if (typeof tooltip === 'string') return tooltip;
  return tooltip.value;
}

class FakeStatusBarItem {
  text = '';
  tooltip: string | vscode.MarkdownString = '';
  command: string | vscode.Command | undefined;
  hidden = true;
  disposed = false;

  show() { this.hidden = false; }
  hide() { this.hidden = true; }
  dispose() { this.disposed = true; }
}
