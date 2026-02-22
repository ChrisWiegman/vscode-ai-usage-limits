import * as vscode from 'vscode';
import { StatusBarManager } from './statusBarManager';
import { ClaudeProvider } from './providers/claudeProvider';
import { OpenAIProvider } from './providers/openaiProvider';

/** How often (ms) to poll for updated budget information. */
const REFRESH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

const SHOW_OUTPUT_COMMAND = 'ai-limits.showOutput';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel('AI Limits');
  const statusBar = new StatusBarManager(SHOW_OUTPUT_COMMAND);
  const claude = new ClaudeProvider();
  const openai = new OpenAIProvider();

  context.subscriptions.push(output, statusBar);

  context.subscriptions.push(
    vscode.commands.registerCommand(SHOW_OUTPUT_COMMAND, () => output.show())
  );

  async function refresh(): Promise<void> {
    const [claudeResult, openaiResult] = await Promise.allSettled([
      claude.getStatus(),
      openai.getStatus(),
    ]);

    const claudeStatus = claudeResult.status === 'fulfilled'
      ? claudeResult.value
      : { available: true, authenticated: false, budget: null, error: String(claudeResult.reason) };

    const openaiStatus = openaiResult.status === 'fulfilled'
      ? openaiResult.value
      : { available: true, authenticated: false, budget: null, error: String(openaiResult.reason) };

    statusBar.updateClaude(claudeStatus);
    statusBar.updateOpenAI(openaiStatus);

    // Log errors to the output channel so they are always visible.
    const timestamp = new Date().toLocaleTimeString();
    if (claudeStatus.error) {
      output.appendLine(`[${timestamp}] Claude error: ${claudeStatus.error}`);
    }
    if (openaiStatus.error) {
      output.appendLine(`[${timestamp}] Codex error: ${openaiStatus.error}`);
    }
  }

  // Initial fetch
  await refresh();

  // Periodic refresh
  const timer = setInterval(() => { void refresh(); }, REFRESH_INTERVAL_MS);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });

  // Refresh when any extension is installed or uninstalled
  context.subscriptions.push(
    vscode.extensions.onDidChange(() => { void refresh(); })
  );

  // Refresh when authentication sessions change (user signs in/out)
  context.subscriptions.push(
    vscode.authentication.onDidChangeSessions(() => { void refresh(); })
  );
}

export function deactivate(): void {
  // Nothing to clean up beyond the subscriptions already registered.
}
