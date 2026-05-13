import * as assert from 'assert';
import * as vscode from 'vscode';
import * as sinon from 'sinon';
import { StatusBarManager } from '../../src/statusBarManager';
import { ProviderStatus } from '../../src/types';

suite('StatusBarManager', () => {
  let manager: StatusBarManager;
  let item: FakeStatusBarItem;
  let createStub: sinon.SinonStub;

  setup(() => {
    item = new FakeStatusBarItem();
    createStub = sinon.stub(vscode.window, 'createStatusBarItem').returns(item as unknown as vscode.StatusBarItem);

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

  test('hides item when both extensions are not available', () => {
    manager.updateClaude(notAvailable());
    manager.updateOpenAI(notAvailable());
    assert.ok(item.hidden, 'item should be hidden');
  });

  test('hides item when Claude is not available and OpenAI has not reported yet', () => {
    manager.updateClaude(notAvailable());
    assert.ok(item.hidden, 'item should be hidden');
  });

  test('shows login prompt when Claude is not authenticated', () => {
    manager.updateClaude({ available: true, authenticated: false, budget: null, error: null });
    assert.ok(!item.hidden);
    assert.ok(item.text.includes('Please log in'), `expected "Please log in" in "${item.text}"`);
    assert.ok(!item.text.includes('Claude'), `did not expect full label in "${item.text}"`);
    assert.strictEqual(item.command, 'ai-limits.openClaudeSettings');
  });

  test('shows error state when Claude has an error', () => {
    manager.updateClaude({ available: true, authenticated: true, budget: null, error: 'timeout' });
    assert.ok(!item.hidden);
    assert.ok(item.text.includes('error'), `expected "error" in "${item.text}"`);
    assert.ok(!item.text.includes('Claude'), `did not expect full label in "${item.text}"`);
    assert.strictEqual(item.command, 'ai-limits.showOutput');
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
    assert.ok(!item.hidden);
    assert.ok(item.text.includes('5h: $0.12'), `"5h" cost in "${item.text}"`);
    assert.ok(item.text.includes('7d: $1.57'), `"7d" cost in "${item.text}"`);
    assert.ok(!item.text.includes('Claude'), `did not expect full label in "${item.text}"`);
    assert.strictEqual(item.command, 'ai-limits.openClaudeSettings');
  });

  test('shows loading spinner when budget is null but authenticated', () => {
    manager.updateClaude({ available: true, authenticated: true, budget: null, error: null });
    assert.ok(!item.hidden);
    assert.ok(item.text.includes('...'), `expected compact loading state in "${item.text}"`);
    assert.ok(!item.text.includes('Claude'), `did not expect full label in "${item.text}"`);
  });

  test('shows no-usage-yet state when both budget windows are missing', () => {
    manager.updateClaude({
      available: true,
      authenticated: true,
      budget: { fiveHour: null, oneWeek: null },
      error: null,
    });
    assert.ok(!item.hidden);
    assert.ok(item.text.includes('No usage yet'), `expected "No usage yet" in "${item.text}"`);
    assert.ok(!item.text.includes('Claude'), `did not expect full label in "${item.text}"`);
    const tooltip = tooltipValue(item.tooltip);
    assert.ok(tooltip.includes('No usage has been recorded yet'), `unexpected tooltip: ${tooltip}`);
  });

  // -------------------------------------------------------------------------
  // updateOpenAI
  // -------------------------------------------------------------------------

  test('hides item when OpenAI is not available and Claude has not reported yet', () => {
    manager.updateOpenAI(notAvailable());
    assert.ok(item.hidden, 'item should be hidden');
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
    assert.ok(!item.hidden);
    assert.ok(item.text.includes('5h: $0.05'), `5h cost in "${item.text}"`);
    assert.ok(item.text.includes('7d: $3.00'), `7d cost in "${item.text}"`);
    assert.ok(!item.text.includes('Codex'), `did not expect full label in "${item.text}"`);
    assert.strictEqual(item.command, 'ai-limits.openOpenAISettings');
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
    assert.ok(item.text.includes('5h: 3%'), `5h percent in "${item.text}"`);
    assert.ok(item.text.includes('7d: 13%'), `7d percent in "${item.text}"`);
    assert.ok(!item.text.includes('Codex'), `did not expect full label in "${item.text}"`);
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
    assert.ok(!item.hidden);
    assert.ok(!item.text.includes('No usage yet'), `did not expect no-usage in "${item.text}"`);
    assert.ok(!item.text.includes('5h:'), `did not expect 5h window in "${item.text}"`);
    assert.ok(item.text.includes('7d: 13%'), `expected 7d window in "${item.text}"`);
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
    const tooltip = tooltipValue(item.tooltip);
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
    const tooltip = tooltipValue(item.tooltip);
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
    assert.ok(item.tooltip instanceof vscode.MarkdownString);
    assert.strictEqual((item.tooltip as vscode.MarkdownString).isTrusted, false);
  });

  // -------------------------------------------------------------------------
  // combined rendering
  // -------------------------------------------------------------------------

  test('shows both providers when both are available', () => {
    manager.updateClaude({
      available: true,
      authenticated: true,
      error: null,
      budget: { fiveHour: { used: 10, limit: 100, unit: 'percent' }, oneWeek: null },
    });
    manager.updateOpenAI({
      available: true,
      authenticated: true,
      error: null,
      budget: { fiveHour: null, oneWeek: { used: 5, limit: 20, unit: 'usd' } },
    });
    assert.ok(!item.hidden);
    assert.ok(item.text.includes('5h: 10%'), `expected Claude 5h in "${item.text}"`);
    assert.ok(item.text.includes('7d: $5.00'), `expected OpenAI 7d in "${item.text}"`);
  });

  test('shows only OpenAI when Claude becomes unavailable', () => {
    manager.updateClaude({ available: false, authenticated: false, budget: null, error: null });
    manager.updateOpenAI({
      available: true,
      authenticated: true,
      error: null,
      budget: { fiveHour: { used: 3, limit: 100, unit: 'percent' }, oneWeek: null },
    });
    assert.ok(!item.hidden);
    assert.ok(item.text.includes('5h: 3%'), `expected OpenAI data in "${item.text}"`);
  });

  // -------------------------------------------------------------------------
  // dispose
  // -------------------------------------------------------------------------

  test('dispose calls dispose on the status bar item', () => {
    manager.dispose();
    assert.ok(item.disposed, 'item should be disposed');
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
