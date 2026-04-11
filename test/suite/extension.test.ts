import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import * as extensionModule from '../../src/extension';
import { StatusBarManager } from '../../src/statusBarManager';
import { ClaudeProvider } from '../../src/providers/claudeProvider';
import { OpenAIProvider } from '../../src/providers/openaiProvider';
import { ProviderStatus } from '../../src/types';

const noop = (): void => undefined;

suite('extension activation', () => {
  let sandbox: sinon.SinonSandbox;
  let fakeClock: sinon.SinonFakeTimers;
  let output: FakeOutputChannel;
  let commandHandlers: Map<string, () => unknown>;
  let claudeStatus: ProviderStatus;
  let openaiStatus: ProviderStatus;
  let getClaudeStatusStub: sinon.SinonStub;
  let getOpenAIStatusStub: sinon.SinonStub;
  let updateClaudeStub: sinon.SinonStub;
  let updateOpenAIStub: sinon.SinonStub;
  let setRefreshInfoStub: sinon.SinonStub;

  setup(() => {
    sandbox = sinon.createSandbox();
    fakeClock = sinon.useFakeTimers({
      now: new Date('2026-04-11T14:00:00.000Z'),
      shouldAdvanceTime: false,
    });

    output = new FakeOutputChannel();
    commandHandlers = new Map<string, () => unknown>();

    claudeStatus = {
      available: true,
      authenticated: true,
      budget: { fiveHour: { used: 12, limit: 100, unit: 'percent' }, oneWeek: null },
      error: null,
    };
    openaiStatus = {
      available: true,
      authenticated: true,
      budget: { fiveHour: null, oneWeek: { used: 5, limit: 20, unit: 'usd' } },
      error: null,
    };

    sandbox.stub(vscode.window, 'createOutputChannel').callsFake(() => output as unknown as vscode.LogOutputChannel);
    sandbox.stub(vscode.window, 'createStatusBarItem').returns(new FakeStatusBarItem() as unknown as vscode.StatusBarItem);
    sandbox.stub(vscode.commands, 'registerCommand').callsFake((command, callback) => {
      commandHandlers.set(command, callback as () => unknown);
      return { dispose: noop };
    });
    sandbox.stub(vscode.env, 'openExternal').resolves(true);
    sandbox.stub(vscode.extensions, 'onDidChange').returns({ dispose: noop });
    sandbox.stub(vscode.authentication, 'onDidChangeSessions').returns({ dispose: noop });

    getClaudeStatusStub = sandbox.stub(ClaudeProvider.prototype, 'getStatus').callsFake(async () => claudeStatus);
    getOpenAIStatusStub = sandbox.stub(OpenAIProvider.prototype, 'getStatus').callsFake(async () => openaiStatus);
    updateClaudeStub = sandbox.stub(StatusBarManager.prototype, 'updateClaude');
    updateOpenAIStub = sandbox.stub(StatusBarManager.prototype, 'updateOpenAI');
    setRefreshInfoStub = sandbox.stub(StatusBarManager.prototype, 'setRefreshInfo');
  });

  teardown(() => {
    fakeClock.restore();
    sandbox.restore();
  });

  test('registers commands and refreshes statuses during activation', async () => {
    const context = fakeContext();

    await extensionModule.activate(context);

    assert.ok(commandHandlers.has('ai-limits.showOutput'));
    assert.ok(commandHandlers.has('ai-limits.openClaudeSettings'));
    assert.ok(commandHandlers.has('ai-limits.openOpenAISettings'));
    assert.strictEqual(getClaudeStatusStub.callCount, 1);
    assert.strictEqual(getOpenAIStatusStub.callCount, 1);
    assert.strictEqual(updateClaudeStub.callCount, 1);
    assert.strictEqual(updateOpenAIStub.callCount, 1);
    assert.deepStrictEqual(updateClaudeStub.firstCall.args[0], claudeStatus);
    assert.deepStrictEqual(updateOpenAIStub.firstCall.args[0], openaiStatus);
    assert.strictEqual(setRefreshInfoStub.callCount, 1);
    assert.ok(context.subscriptions.length >= 5, 'expected output, status bar, commands, timer, and listeners');
  });

  test('opens the correct external URLs and shows output channel from commands', async () => {
    await extensionModule.activate(fakeContext());

    await commandHandlers.get('ai-limits.openClaudeSettings')?.();
    await commandHandlers.get('ai-limits.openOpenAISettings')?.();
    commandHandlers.get('ai-limits.showOutput')?.();

    const openExternalStub = vscode.env.openExternal as sinon.SinonStub;
    assert.strictEqual(openExternalStub.callCount, 2);
    assert.strictEqual(openExternalStub.firstCall.firstArg.toString(), 'https://claude.ai/settings/usage');
    assert.strictEqual(openExternalStub.secondCall.firstArg.toString(), 'https://chatgpt.com/codex/settings/usage');
    assert.strictEqual(output.showCallCount, 1);
  });

  test('logs provider errors, including rejected refreshes, to the output channel', async () => {
    claudeStatus = { available: true, authenticated: true, budget: null, error: 'rate limited' };
    getOpenAIStatusStub.restore();
    getOpenAIStatusStub = sandbox.stub(OpenAIProvider.prototype, 'getStatus').rejects(new Error('boom'));

    await extensionModule.activate(fakeContext());

    assert.ok(output.lines.some((line) => line.includes('Claude error: rate limited')), output.lines.join('\n'));
    assert.ok(output.lines.some((line) => line.includes('Codex error: Error: boom')), output.lines.join('\n'));
    assert.strictEqual(updateOpenAIStub.callCount, 1);
    assert.strictEqual(updateOpenAIStub.firstCall.args[0].error, 'Error: boom');
  });

  test('records refresh timing during activation', async () => {
    await extensionModule.activate(fakeContext());
    assert.strictEqual(setRefreshInfoStub.callCount, 1);
    const [last, next] = setRefreshInfoStub.firstCall.args as [Date, Date];
    assert.strictEqual(next.getTime() - last.getTime(), 5 * 60 * 1000);
  });

  test('runs the periodic refresh and clears the timer on dispose', async () => {
    const context = fakeContext();

    await extensionModule.activate(context);
    await fakeClock.tickAsync(5 * 60 * 1000);

    assert.strictEqual(getClaudeStatusStub.callCount, 2);
    assert.strictEqual(getOpenAIStatusStub.callCount, 2);

    for (const subscription of context.subscriptions) {
      if (typeof (subscription as { dispose?: unknown }).dispose === 'function') {
        (subscription as { dispose(): void }).dispose();
      }
    }

    await fakeClock.tickAsync(5 * 60 * 1000);
    assert.strictEqual(getClaudeStatusStub.callCount, 2, 'timer should not fire after disposal');
    assert.strictEqual(getOpenAIStatusStub.callCount, 2, 'timer should not fire after disposal');
  });
});

function fakeContext(): vscode.ExtensionContext {
  return {
    subscriptions: [],
  } as unknown as vscode.ExtensionContext;
}

class FakeOutputChannel {
  readonly lines: string[] = [];
  showCallCount = 0;

  appendLine(value: string): void {
    this.lines.push(value);
  }

  show(): void {
    this.showCallCount += 1;
  }

  dispose = noop;
}

class FakeStatusBarItem {
  text = '';
  tooltip: string | vscode.MarkdownString = '';
  command: string | vscode.Command | undefined;

  show = noop;
  hide = noop;
  dispose = noop;
}
