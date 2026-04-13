import * as vscode from 'vscode';
import { StatusBarManager } from './statusBarManager';
import { ClaudeProvider } from './providers/claudeProvider';
import { OpenAIProvider } from './providers/openaiProvider';
import { clearCache } from './sharedCache';

/** How often (ms) to poll for updated budget information. */
const REFRESH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

const SHOW_OUTPUT_COMMAND = 'ai-limits.showOutput';
const OPEN_CLAUDE_SETTINGS_COMMAND = 'ai-limits.openClaudeSettings';
const OPEN_OPENAI_SETTINGS_COMMAND = 'ai-limits.openOpenAISettings';
const REFRESH_COMMAND = 'ai-limits.refresh';
const CLAUDE_SETTINGS_URL = 'https://claude.ai/settings/usage';
const OPENAI_SETTINGS_URL = 'https://chatgpt.com/codex/settings/usage';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel('AI Limits');
  const statusBar = new StatusBarManager(
    SHOW_OUTPUT_COMMAND,
    OPEN_CLAUDE_SETTINGS_COMMAND,
    OPEN_OPENAI_SETTINGS_COMMAND
  );
  const claude = new ClaudeProvider();
  const openai = new OpenAIProvider();

  context.subscriptions.push(output, statusBar);

  context.subscriptions.push(
    vscode.commands.registerCommand(SHOW_OUTPUT_COMMAND, () => output.show()),
    vscode.commands.registerCommand(OPEN_CLAUDE_SETTINGS_COMMAND, () =>
      vscode.env.openExternal(vscode.Uri.parse(CLAUDE_SETTINGS_URL))
    ),
    vscode.commands.registerCommand(OPEN_OPENAI_SETTINGS_COMMAND, () =>
      vscode.env.openExternal(vscode.Uri.parse(OPENAI_SETTINGS_URL))
    ),
    vscode.commands.registerCommand(REFRESH_COMMAND, () => {
      clearCache();
      void refresh();
    })
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

    const now = new Date();
    statusBar.setRefreshInfo(now, new Date(now.getTime() + REFRESH_INTERVAL_MS));
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

  // Debounced refresh for event-driven triggers to avoid back-to-back API
  // bursts (e.g. the extension's own installation fires onDidChange).
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  const debouncedRefresh = (): void => {
    if (debounceTimer !== undefined) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined;
      void refresh();
    }, 5_000);
  };

  // Refresh when any extension is installed or uninstalled
  context.subscriptions.push(
    vscode.extensions.onDidChange(debouncedRefresh)
  );

  // Refresh when authentication sessions change (user signs in/out)
  context.subscriptions.push(
    vscode.authentication.onDidChangeSessions(debouncedRefresh)
  );
}

export function deactivate(): void {
  // Nothing to clean up beyond the subscriptions already registered.
}
