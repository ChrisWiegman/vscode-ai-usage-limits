import * as vscode from 'vscode';
import { ClaudeProvider } from './providers/claudeProvider';
import { OpenAIProvider } from './providers/openaiProvider';
import { clearCache } from './sharedCache';
import { StatusBarManager } from './statusBarManager';

/** How often (ms) to poll for updated budget information. */
const REFRESH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

const SHOW_OUTPUT_COMMAND = 'ai-limits.showOutput';
const OPEN_CLAUDE_SETTINGS_COMMAND = 'ai-limits.openClaudeSettings';
const OPEN_OPENAI_SETTINGS_COMMAND = 'ai-limits.openOpenAISettings';
const REFRESH_COMMAND = 'ai-limits.refresh';
const CLAUDE_SETTINGS_URL = 'https://claude.ai/settings/usage';
const OPENAI_SETTINGS_URL = 'https://chatgpt.com/codex/settings/usage';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // Create the output channel first so any early error can be logged.
  const output = vscode.window.createOutputChannel('AI Limits');

  context.subscriptions.push(output);
  output.appendLine(`[${new Date().toLocaleTimeString()}] AI Limits activating…`);

  let statusBar: StatusBarManager;

  try {
    statusBar = new StatusBarManager(
      SHOW_OUTPUT_COMMAND,
      OPEN_CLAUDE_SETTINGS_COMMAND,
      OPEN_OPENAI_SETTINGS_COMMAND
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);

    output.appendLine(`[${new Date().toLocaleTimeString()}] FATAL: Could not create status bar items: ${msg}`);
    output.show();
    return;
  }

  context.subscriptions.push(statusBar);

  const claude = new ClaudeProvider();
  const openai = new OpenAIProvider();

  try {
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
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);

    output.appendLine(`[${new Date().toLocaleTimeString()}] FATAL: Could not register commands: ${msg}`);
    output.show();
    return;
  }

  output.appendLine(`[${new Date().toLocaleTimeString()}] AI Limits activated`);

  // Show items immediately in loading state so the status bar is populated before
  // the first async refresh completes (which can take up to FETCH_TIMEOUT_MS).
  const loadingStatus = { available: true, authenticated: true, budget: null, error: null };

  statusBar.updateClaude(loadingStatus);
  statusBar.updateOpenAI(loadingStatus);

  // Returns true if any companion extension was not yet registered (retry needed).
  async function refresh(): Promise<boolean> {
    output.appendLine(`[${new Date().toLocaleTimeString()}] refresh: starting`);

    const timeout = (ms: number, label: string): Promise<never> =>
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
      );

    const [claudeResult, openaiResult] = await Promise.allSettled([
      Promise.race([claude.getStatus(), timeout(14_000, 'claude.getStatus()')]),
      Promise.race([openai.getStatus(), timeout(14_000, 'openai.getStatus()')]),
    ]);

    output.appendLine(`[${new Date().toLocaleTimeString()}] refresh: allSettled resolved`);

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

    const timestamp = new Date().toLocaleTimeString();

    output.appendLine(`[${timestamp}] Claude: available=${claudeStatus.available} authenticated=${claudeStatus.authenticated} budget=${JSON.stringify(claudeStatus.budget)} error=${claudeStatus.error ?? 'none'}`);
    output.appendLine(`[${timestamp}] Codex:  available=${openaiStatus.available} authenticated=${openaiStatus.authenticated} budget=${JSON.stringify(openaiStatus.budget)} error=${openaiStatus.error ?? 'none'}`);

    if (claudeStatus.error) {
      output.appendLine(`[${timestamp}] Claude error: ${claudeStatus.error}`);
    } else if (!claudeStatus.available) {
      output.appendLine(`[${timestamp}] Claude Code extension not found — status bar item hidden`);
    } else if (!claudeStatus.authenticated) {
      output.appendLine(`[${timestamp}] Claude Code: no credentials found — please log in`);
    }

    if (openaiStatus.error) {
      output.appendLine(`[${timestamp}] Codex error: ${openaiStatus.error}`);
    } else if (!openaiStatus.available) {
      output.appendLine(`[${timestamp}] Codex (openai.chatgpt) extension not found — status bar item hidden`);
    } else if (!openaiStatus.authenticated) {
      output.appendLine(`[${timestamp}] Codex: no credentials found — please log in`);
    }

    return !claudeStatus.available || !openaiStatus.available;
  }

  // Debounced refresh for event-driven triggers to avoid back-to-back API
  // bursts (e.g. the extension's own installation fires onDidChange).
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;

  // Cancel any pending debounce on deactivation.  Without this, a timer that
  // fired after the context was disposed would call refresh() against already-
  // disposed StatusBarItems, which can crash the extension host and take the
  // entire status bar down with it.
  context.subscriptions.push({
    dispose(): void {
      if (debounceTimer !== undefined) {
        clearTimeout(debounceTimer);
        debounceTimer = undefined;
      }
    },
  });

  const debouncedRefresh = (): void => {
    if (debounceTimer !== undefined) {
      clearTimeout(debounceTimer);
    }

    debounceTimer = setTimeout(() => {
      debounceTimer = undefined;
      void refresh();
    }, 5_000);
  };

  // Subscribe before the initial refresh so we never miss a change event
  // that fires during startup before our listener is registered.
  context.subscriptions.push(
    vscode.extensions.onDidChange(debouncedRefresh)
  );

  // Refresh when authentication sessions change (user signs in/out)
  context.subscriptions.push(
    vscode.authentication.onDidChangeSessions(debouncedRefresh)
  );

  // Initial fetch
  const anyUnavailable = await refresh();

  // Periodic refresh
  const timer = setInterval(() => { void refresh(); }, REFRESH_INTERVAL_MS);

  context.subscriptions.push({ dispose: () => clearInterval(timer) });

  // One-time delayed retry: onStartupFinished does not guarantee all
  // extensions are registered yet. Only schedule when a companion extension
  // (Claude or Codex) was missing from the initial check, so we don't retry
  // needlessly when both were already visible.
  if (anyUnavailable) {
    const startupRetry = setTimeout(() => { void refresh(); }, 10_000);

    context.subscriptions.push({ dispose: () => clearTimeout(startupRetry) });
  }
}

export function deactivate(): void {
  // Nothing to clean up beyond the subscriptions already registered.
}
